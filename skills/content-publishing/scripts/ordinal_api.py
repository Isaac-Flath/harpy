#!/usr/bin/env python3
"""Small official Ordinal API client used by the ordinal-publishing skill.

The client intentionally implements only the documented operations needed by the
publishing workflow. It reads ORDINAL_API_KEY from the environment or ~/.secrets
and never prints the credential or signed upload fields.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = "https://app.tryordinal.com/api/v1"
DEFAULT_SECRETS_FILE = Path.home() / ".secrets"
TERMINAL_UPLOAD_FAILURES = {"failed", "expired"}


class OrdinalApiError(RuntimeError):
    """An actionable Ordinal API or local upload error."""


def _secret_from_file(path: Path, name: str) -> str | None:
    if not path.exists():
        return None
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        if separator and key.strip() == name:
            value = value.strip()
            if not value:
                return None
            try:
                parsed = shlex.split(value, comments=True)
            except ValueError as error:
                raise OrdinalApiError(f"Could not parse {name} in {path}: {error}") from error
            return parsed[0] if parsed else None
    return None


def load_api_key(secrets_file: Path) -> str:
    key = os.environ.get("ORDINAL_API_KEY") or _secret_from_file(secrets_file, "ORDINAL_API_KEY")
    if not key:
        raise OrdinalApiError(
            "ORDINAL_API_KEY is not set and was not found in "
            f"{secrets_file}."
        )
    return key


def _json_body(response: urllib.response) -> Any:
    raw = response.read()
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"raw": raw.decode("utf-8", errors="replace")}


class OrdinalApi:
    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any | None = None,
        query: dict[str, str | int | None] | None = None,
    ) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        if query:
            encoded = [(key, value) for key, value in query.items() if value is not None]
            if encoded:
                url = f"{url}?{urllib.parse.urlencode(encoded)}"

        data = None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return _json_body(response)
        except urllib.error.HTTPError as error:
            response_body = error.read().decode("utf-8", errors="replace")
            # The API response is useful for diagnosis, but never include request
            # headers or the bearer credential in an error.
            preview = response_body[:1200] if response_body else error.reason
            raise OrdinalApiError(
                f"Ordinal API {method} {path} returned HTTP {error.code}: {preview}"
            ) from error
        except urllib.error.URLError as error:
            raise OrdinalApiError(f"Could not reach Ordinal API: {error.reason}") from error


def upload_local_file(api: OrdinalApi, file_path: Path, *, poll_seconds: float, timeout: float) -> dict[str, Any]:
    if not file_path.is_file():
        raise OrdinalApiError(f"File not found: {file_path}")

    mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    size = file_path.stat().st_size
    if size <= 0:
        raise OrdinalApiError(f"File is empty: {file_path}")

    prepared = api.request(
        "POST",
        "/uploads/prepare",
        body={"filename": file_path.name, "mimetype": mime_type, "size": size},
    )
    required = ("id", "uploadUrl", "params", "signature")
    missing = [key for key in required if not prepared.get(key)]
    if missing:
        raise OrdinalApiError(
            "Ordinal upload preparation omitted required fields: " + ", ".join(missing)
        )

    # The signed fields must be passed exactly as returned. --form-string prevents
    # curl from interpreting the signed JSON as a filename or form directive.
    curl_command = [
        "curl",
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--request",
        "POST",
        str(prepared["uploadUrl"]),
        "--form-string",
        f"params={prepared['params']}",
        "--form-string",
        f"signature={prepared['signature']}",
        "--form",
        f"file=@{file_path};type={mime_type}",
    ]
    try:
        upload = subprocess.run(
            curl_command,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired as error:
        raise OrdinalApiError(f"Signed upload timed out for {file_path.name}") from error
    if upload.returncode != 0:
        detail = upload.stderr.strip()[-800:] or "curl returned no error detail"
        raise OrdinalApiError(f"Signed upload failed for {file_path.name}: {detail}")

    deadline = time.monotonic() + timeout
    while True:
        status = api.request("GET", f"/uploads/{prepared['id']}")
        state = status.get("status")
        if state == "ready":
            if not status.get("assetId"):
                raise OrdinalApiError("Ordinal marked the upload ready without an assetId")
            return status
        if state in TERMINAL_UPLOAD_FAILURES:
            detail = status.get("error") or state
            raise OrdinalApiError(f"Ordinal upload {prepared['id']} ended as {state}: {detail}")
        if time.monotonic() >= deadline:
            raise OrdinalApiError(
                f"Timed out waiting for upload {prepared['id']} to become ready; last status: {state}"
            )
        time.sleep(poll_seconds)


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Call the documented Ordinal REST API.")
    parser.add_argument("--base-url", default=os.environ.get("ORDINAL_API_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--secrets-file", type=Path, default=DEFAULT_SECRETS_FILE)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("workspace", help="Fetch the current workspace and timezone.")
    sub.add_parser("profiles", help="Fetch profiles that can schedule posts.")

    upload = sub.add_parser("upload", help="Upload a local file and wait for a ready asset.")
    upload.add_argument("file", type=Path)
    upload.add_argument("--poll-seconds", type=float, default=2.0)
    upload.add_argument("--timeout", type=float, default=600.0)

    post_list = sub.add_parser("post-list", help="List posts with optional schedule filters.")
    post_list.add_argument("--limit", type=int, default=100)
    post_list.add_argument("--cursor")
    post_list.add_argument("--status")
    post_list.add_argument("--channel")
    post_list.add_argument("--publish-date-min")
    post_list.add_argument("--publish-date-max")
    post_list.add_argument("--sort-by", default="publishAt")
    post_list.add_argument("--sort-order", default="asc")

    post_get = sub.add_parser("post-get", help="Fetch one post for verification.")
    post_get.add_argument("id")

    post_create = sub.add_parser("post-create", help="Create a post from a JSON payload file, or '-' for stdin.")
    post_create.add_argument("payload", type=Path)

    post_update = sub.add_parser("post-update", help="Patch a post from a JSON payload file, or '-' for stdin.")
    post_update.add_argument("id")
    post_update.add_argument("payload", type=Path)

    schedule = sub.add_parser("post-schedule", help="Schedule or reschedule a post in UTC.")
    schedule.add_argument("id")
    schedule.add_argument("--publish-at", required=True)

    unschedule = sub.add_parser("post-unschedule", help="Unschedule a post.")
    unschedule.add_argument("id")

    return parser


def read_json_file(path: Path) -> Any:
    source = "stdin" if str(path) == "-" else str(path)
    try:
        raw = sys.stdin.read() if source == "stdin" else path.read_text()
        return json.loads(raw)
    except OSError as error:
        raise OrdinalApiError(f"Could not read JSON payload {source}: {error}") from error
    except json.JSONDecodeError as error:
        raise OrdinalApiError(f"Invalid JSON payload {source}: {error}") from error


def main() -> int:
    args = build_parser().parse_args()
    try:
        api = OrdinalApi(args.base_url, load_api_key(args.secrets_file))
        if args.command == "workspace":
            result = api.request("GET", "/workspace")
        elif args.command == "profiles":
            result = api.request("GET", "/profiles/scheduling")
        elif args.command == "upload":
            result = upload_local_file(
                api,
                args.file.expanduser().resolve(),
                poll_seconds=args.poll_seconds,
                timeout=args.timeout,
            )
        elif args.command == "post-list":
            result = api.request(
                "GET",
                "/posts",
                query={
                    "limit": args.limit,
                    "cursor": args.cursor,
                    "status": args.status,
                    "channel": args.channel,
                    "publishDateMin": args.publish_date_min,
                    "publishDateMax": args.publish_date_max,
                    "sortBy": args.sort_by,
                    "sortOrder": args.sort_order,
                },
            )
        elif args.command == "post-get":
            result = api.request("GET", f"/posts/{args.id}")
        elif args.command == "post-create":
            result = api.request("POST", "/posts", body=read_json_file(args.payload))
        elif args.command == "post-update":
            result = api.request("PATCH", f"/posts/{args.id}", body=read_json_file(args.payload))
        elif args.command == "post-schedule":
            result = api.request(
                "POST",
                f"/posts/{args.id}/schedule",
                body={"publishAt": args.publish_at},
            )
        elif args.command == "post-unschedule":
            result = api.request("POST", f"/posts/{args.id}/unschedule")
        else:  # argparse enforces this, but keep the branch explicit for callers.
            raise OrdinalApiError(f"Unknown command: {args.command}")
        print_json(result)
        return 0
    except OrdinalApiError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
