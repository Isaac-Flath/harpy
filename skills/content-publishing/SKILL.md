---
name: content-publishing
description: Apply Isaac's channel-copy, CTA, export, news, and webinar conventions when preparing or publishing content.
---

# Isaac's publishing conventions

## Social posts

- Keep copy close to my spoken transcript, including qualifications. No em dashes or generic marketing hooks.
- Split-export names: `_X` → X/LinkedIn, `_yt` → YouTube Shorts/TikTok, `_insta` → Instagram. Keep those channel-specific versions separate.
- On X, put the full narrative in one long-form post. An optional second post contains only the CTA URL.
- News CTA: `https://isaacflath.com/news`; no ManyChat. OCR/document-processing CTA: `https://isaacflath.com/pdf2production`; on Instagram use the existing `PDF` ManyChat keyword instead of a caption URL.
- Use the designed first frame as the video cover, with a portrait PNG beside the final export for Shorts. When speech captions are burned in, avoid duplicate automatic YouTube captions; preserve authored/translated tracks.

## Website and news

- News videos go to `s3://isaacflath/ocr-news/videos/YYYY-MM-DD/<slug>.mp4`. Queue a **draft** reaction for the existing source item in the website's private `/document-news` editor; don't publish the reaction automatically.
- Website image uploads use that repo's `site/scripts/s3_utils.py`; consult `site/README.md` and `justfile` for current commands.

## Webinars

- Keep the event bundle in the website repo at `webinars/events/<id>/`; follow `webinars/README.md` there.
- Free Luma registration, Riverside **audience** access for attendees; speaker invites stay separate.
- Promote the Luma signup URL. Linked Instagram Stories use a native **Join us free** sticker to Luma, not ManyChat or the course URL.
