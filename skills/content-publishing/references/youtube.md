# Covers and captions

Check current platform capabilities before acting; these are known workflow constraints, not permanent API guarantees.

- Export and inspect the designed first frame: `ffmpeg -i video.mp4 -frames:v 1 cover.png`. Use a new filename if an output exists.
- TikTok: supported config uses `videoCoverTimestampMs: 0`.
- Instagram Reel: upload the first-frame PNG and use its asset ID as `coverPhotoId` when supported.
- YouTube Shorts: Ordinal has no thumbnail field. Preserve a portrait PNG next to the final video. After publication, identify the exact video ID and run `uv run --with google-api-python-client --with google-auth-oauthlib python scripts/youtube_thumbnail.py set VIDEO_ID cover.png` from this skill. The helper docstring explains OAuth setup. If unavailable, hand off manual thumbnail upload in YouTube Studio. Never use direct video upload as a workaround or claim the thumbnail is set before verifying it.
- When the export has embedded speech captions, inspect YouTube subtitle tracks after processing. Back up and remove only the automatic track duplicating those captions, through Studio or a documented supported API. Preserve manually authored/translated tracks. Verify playback with CC enabled and the embedded captions intact.
- An immediately empty track list is pending, not proof automatic captions are disabled. For future schedules or unavailable access, report thumbnail/caption work pending; do not imply a background follow-up exists unless actually arranged.
- Preserve requested visibility and schedule. If prevention of duplicate captions from first public view is required, confirm a supported private-upload/cleanup/release workflow before promising it.
