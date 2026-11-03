#!/usr/bin/env python3
"""Set a YouTube video's thumbnail via the YouTube Data API.

Ordinal cannot set YouTube Shorts thumbnails, so this runs after Ordinal
publishes. thumbnails.set is not affected by the videos.insert audit
restriction; it only needs OAuth for the channel.

One-time setup (Google Cloud Console):
  1. Create a project, enable "YouTube Data API v3".
  2. OAuth consent screen: External, publishing status "In production"
     (in "Testing" status refresh tokens expire after 7 days).
  3. Create an OAuth client ID of type "Desktop app", download the JSON to
     ~/.config/youtube-thumbnails/client_secret.json
  4. Run: uv run --with google-api-python-client --with google-auth-oauthlib \
       python youtube_thumbnail.py auth

Usage:
  youtube_thumbnail.py auth                       # one-time OAuth flow
  youtube_thumbnail.py set VIDEO_ID cover.png     # set thumbnail directly
  youtube_thumbnail.py latest --title "..." --cover cover.png
      # find the newest upload whose title matches, then set its thumbnail

Run via uv:
  uv run --with google-api-python-client --with google-auth-oauthlib \
    python youtube_thumbnail.py ...
"""

import argparse
import sys
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "youtube-thumbnails"
CLIENT_SECRET = CONFIG_DIR / "client_secret.json"
TOKEN_FILE = CONFIG_DIR / "token.json"
SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def get_credentials():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    if not TOKEN_FILE.is_file():
        die(f"No token at {TOKEN_FILE}. Run the 'auth' command first.")
    creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json())
    return creds


def cmd_auth() -> None:
    from google_auth_oauthlib.flow import InstalledAppFlow

    if not CLIENT_SECRET.is_file():
        die(f"Put your OAuth Desktop-app client JSON at {CLIENT_SECRET} first.")
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES)
    creds = flow.run_local_server(port=0)
    TOKEN_FILE.write_text(creds.to_json())
    TOKEN_FILE.chmod(0o600)
    print(f"Saved token to {TOKEN_FILE}")


def build_service():
    from googleapiclient.discovery import build

    return build("youtube", "v3", credentials=get_credentials())


def set_thumbnail(youtube, video_id: str, cover: Path) -> None:
    if not cover.is_file():
        die(f"Cover image not found: {cover}")
    if cover.stat().st_size > 2 * 1024 * 1024:
        die(f"{cover} is over YouTube's 2 MB thumbnail limit; re-export smaller.")
    youtube.thumbnails().set(videoId=video_id, media_body=str(cover)).execute()
    print(f"Thumbnail set for https://www.youtube.com/shorts/{video_id} from {cover.name}")


def cmd_set(args) -> None:
    set_thumbnail(build_service(), args.video_id, Path(args.cover))


def cmd_latest(args) -> None:
    youtube = build_service()
    # Uploads playlist ID = channel ID with UC -> UU prefix.
    channels = youtube.channels().list(part="contentDetails", mine=True).execute()
    uploads = channels["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]
    items = (
        youtube.playlistItems()
        .list(part="snippet", playlistId=uploads, maxResults=25)
        .execute()["items"]
    )
    needle = args.title.strip().lower()
    matches = [
        i for i in items
        if needle in i["snippet"]["title"].strip().lower()
    ]
    if not matches:
        recent = "\n  ".join(i["snippet"]["title"] for i in items[:10])
        die(f"No recent upload matches title '{args.title}'. Recent uploads:\n  {recent}")
    video_id = matches[0]["snippet"]["resourceId"]["videoId"]
    print(f"Matched: {matches[0]['snippet']['title']} ({video_id})")
    set_thumbnail(youtube, video_id, Path(args.cover))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("auth", help="Run the one-time OAuth flow")

    p_set = sub.add_parser("set", help="Set thumbnail for a known video ID")
    p_set.add_argument("video_id")
    p_set.add_argument("cover", help="Path to the thumbnail image (max 2 MB)")

    p_latest = sub.add_parser("latest", help="Find newest upload by title and set thumbnail")
    p_latest.add_argument("--title", required=True, help="Title (or substring) to match")
    p_latest.add_argument("--cover", required=True, help="Path to the thumbnail image")

    args = parser.parse_args()
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if args.command == "auth":
        cmd_auth()
    elif args.command == "set":
        cmd_set(args)
    elif args.command == "latest":
        cmd_latest(args)


if __name__ == "__main__":
    main()
