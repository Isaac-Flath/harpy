# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Thin Python client for Harpy's LLM fanout server.

Import from your scripts:

    from harpy_llm import llm_query, llm_query_batched

    answer = llm_query("Summarize this: ...")
    answers = llm_query_batched(["Is this relevant?", "Is that relevant?"])

The module auto-starts `scripts/llm-server.ts` (via `npx tsx`) on first use,
reads the handshake for port + token, and reuses a running server across
calls within the same process. Auth and model resolution live in the TS
server — this side is just HTTP.

To use a different default model, set HARP_LLM_MODEL before importing,
or pass model="provider/id" per call.
"""

from __future__ import annotations

import atexit
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# ---------------------------------------------------------------------------
# Locating the harpy repo root
# ---------------------------------------------------------------------------

def _find_harpy_root() -> Path:
    """Find the harpy repo root."""
    env = os.environ.get("HARPY_ROOT")
    if env:
        return Path(env)
    # This file lives at <root>/scripts/harpy_llm.py
    return Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------

class _Server:
    def __init__(self):
        self.port: int | None = None
        self.token: str | None = None
        self._proc: subprocess.Popen | None = None

    def _ensure_running(self):
        if self.port and self.token and self._alive():
            return
        self._start()

    def _alive(self) -> bool:
        if not self._proc:
            return False
        return self._proc.poll() is None

    def _start(self):
        root = _find_harpy_root()
        server_script = root / "scripts" / "llm-server.ts"
        if not server_script.exists():
            raise RuntimeError(f"llm-server.ts not found at {server_script}")

        cmd = ["npx", "tsx", str(server_script)]

        provider = os.environ.get("HARPY_LLM_PROVIDER", "openai-codex")
        model = os.environ.get("HARPY_LLM_MODEL", "gpt-5.4-mini")
        cmd += ["--provider", provider, "--model", model]

        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(root),
        )

        # Read handshake line: {"port": N, "token": "..."}
        line = self._proc.stdout.readline()
        if not line:
            err = self._proc.stderr.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"llm-server failed to start: {err}")
        try:
            handshake = json.loads(line)
        except json.JSONDecodeError:
            err = self._proc.stderr.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"llm-server bad handshake: {line!r}\n{err}")

        self.port = handshake["port"]
        self.token = handshake["token"]

        atexit.register(self._shutdown)

    def _shutdown(self):
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()

    def call(self, route: str, body: dict) -> dict:
        self._ensure_running()
        url = f"http://127.0.0.1:{self.port}{route}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "X-Harpy-Token": self.token,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            payload = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{route} HTTP {e.code}: {payload}") from None
        except urllib.error.URLError as e:
            raise RuntimeError(f"{route} connection error: {e.reason}") from None

_server = _Server()

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def llm_query(prompt: str, model: str | None = None) -> str:
    """Single LLM call. Returns the response text."""
    body: dict = {"prompt": prompt}
    if model:
        body["model"] = model
    resp = _server.call("/llm_query", body)
    if "error" in resp:
        raise RuntimeError(f"llm_query error: {resp['error']}")
    return resp["result"]

def llm_query_batched(prompts: list[str], model: str | None = None) -> list[str]:
    """Concurrent batch of LLM calls. Returns a list of response texts,
    same order as prompts."""
    body: dict = {"prompts": prompts}
    if model:
        body["model"] = model
    resp = _server.call("/llm_query_batched", body)
    if "error" in resp:
        raise RuntimeError(f"llm_query_batched error: {resp['error']}")
    return resp["result"]
