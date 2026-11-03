---
name: content-publishing
description: Publish and schedule Isaac's content through Ordinal, upload approved public assets, and prepare Luma webinars with Riverside audience access.
---

# Content publishing

For public image uploads, read [images](references/images.md). For event setup, read [webinars](references/webinars.md). The rules below apply to Ordinal social publishing.

- Act only on a request to publish, schedule, edit, or verify. Confirm media, channels, approved copy, and date/time. Default timezone: `America/New_York`; convert with daylight-saving rules and report local time plus UTC.
- Prefer available Ordinal MCP tools; discover their schemas before use. Otherwise use `python3 scripts/ordinal_api.py --help` relative to this skill. It reads `ORDINAL_API_KEY` from the environment or `~/.secrets`. Never expose credentials. If neither transport works, stop; do not substitute browser automation or another publisher without permission.
- Fetch live workspace and profiles; never hardcode IDs. Exclude Threads (unsupported by the documented Ordinal API); report the exclusion. Confirm current API capabilities before sending channel settings.
- Check each file with `ffprobe`, transcribe the final export when drafting copy, and preserve per-channel media assignments. In coordinated split deliveries, `_X` means X/LinkedIn, `_yt` YouTube Shorts/TikTok, and `_insta` Instagram.
- Keep copy close to Isaac's transcript, including qualifications. No em dashes, invented results, or generic marketing hooks. Verify original-source posts and account identities before attributing or tagging.
- News CTA: `https://isaacflath.com/news`, no ManyChat. OCR/document-processing CTA: `https://isaacflath.com/pdf2production`; Instagram uses the existing `PDF` ManyChat keyword instead of a caption URL. Other topics need the supplied CTA. Webinar promotion uses its Luma signup URL. This does not authorize changing ManyChat automations.
- On X, keep the full narrative in one long-form post; an optional second post contains only the CTA URL. Adapt other channels without inventing visibility or interaction defaults.
- For news, upload the final video to `s3://isaacflath/ocr-news/videos/YYYY-MM-DD/<slug>.mp4`, verify public HTTPS access, and queue a **draft** reaction for existing source items in the website's private `/document-news` editor. Read that repo's current instructions; do not use the retired standalone OCR-news feed or publish the reaction automatically.
- Upload each distinct file and wait for ready status. Attach all requested channels at creation (Ordinal cannot add channels later). Inspect the first frame before upload; stop on a black, blurred, or transitional cover. Read [cover and caption checks](references/youtube.md) for Instagram, TikTok, or YouTube delivery.
- Finish assets and copy before scheduling. Re-fetch the post and check each channel's media, copy, visibility, time, and status. A post-level success does not prove every channel scheduled. Report partial failures; avoid duplicate recovery posts.
- Return verified Ordinal/channel links, media mapping, local/UTC time, and pending checks. Distinguish draft, scheduled, published, and verified. Instagram Stories need a real native link sticker; confirm live support rather than claiming a reminder or image-only draft is automatic linked publication.

Run bundled scripts relative to this directory. The API client supports workspace, profiles, upload, post-list, post-create, post-get, post-update, post-schedule, and post-unschedule. Stream JSON on stdin (`-`) for create/update; do not save temporary payloads or credentials.
