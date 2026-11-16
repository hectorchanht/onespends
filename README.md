# OneSpends

All your spends in one place — just need a glance.

Local-first receipt OCR → dashboard. Live at https://onespends.dawnstudio.app

## Layout

- Site root = the static PWA exactly as deployed (no framework, no build step): landing `index.html`, app `app.html`, OCR + parser + sync client under `js/`, vendored offline OCR engines under `vendor/` (Tesseract + PP-OCRv5), tests under `tests/`.
- `worker/` = the cloud-sync backend (Cloudflare Worker + D1): magic-link auth via `@dawn-studio/auth`, schema in `worker/schema.sql`, deploy via `worker/tools/deploy-worker.py`. See `worker/ARCHITECTURE.md`.

## Deploy

Cloudflare Pages direct upload for the site + the Worker deploy script for the backend. Pushing this repo does **not** auto-deploy the live site.
