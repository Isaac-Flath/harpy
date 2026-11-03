# Public content images

- Inspect destination-project instructions and existing S3 tooling first. In `~/git/isaacflath.com`, consult `site/README.md`, `site/scripts/s3_utils.py`, and `justfile`.
- Confirm public bucket/key and that each image may be public. Known asset bucket: `isaacflath`, `us-east-1`. Never infer private bucket names or expose private media.
- Resolve Markdown paths against the actual document/project and verify inputs; skip existing HTTPS URLs. Use configured AWS tooling without exposing credentials.
- Upload PNG/JPEG with correct content type and a new stable key. Verify unauthenticated HTTPS access before replacing references. Preserve originals/provenance and report uploaded files and changed Markdown paths.
- Image upload does not authorize site deployment, post publication, bucket-policy changes, deletion, or unrelated overwrites.
