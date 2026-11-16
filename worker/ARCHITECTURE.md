# OneSpends — magic login + cloud sync: architecture & redeploy guide

Shipped 2026-10-26. The PWA stays a pure static Pages direct-upload; the API
is a separate Worker routed in front of `/api/*`. No git repo — this folder
is the source of truth for the backend; the site source is `~/workspace/onespends/`.

## Pieces

| Piece | Value |
|---|---|
| Site | Pages project `onespends`, live at https://onespends.dawnstudio.app (deploy = full-set direct upload, see below) |
| API Worker | script name `onespends-api`, zone route `onespends.dawnstudio.app/api/*` → `onespends-api` (route id e29efc5d78c2443ba2dbc8706d65746e, zone dawnstudio.app `61e33b44fb4163f8865193b64216957e`) |
| Database | D1 `onespends-db`, id `40e08871-7b2b-4c07-a272-e9ac5b7e5e2b` (account f1868a071996e836eae6da2b65f37929) |
| Worker bindings | `DB` → onespends-db; `RESEND_API_KEY` → secret_text (domain-scoped Resend sending key for dawnstudio.app, minted fresh by the deploy script; value never stored here) |
| Sender | `Dawn Studio <login@dawnstudio.app>` via Resend account B (hectorchanht) — see `~/workspace/custom-connectors/custom.legacy-resend/REGISTRY.md` |
| Auth | `@dawn-studio/auth` v0.2.0 (`~/workspace/dawn-auth`, bundled from `dist/`) — FULL MAGIC: one email carries link + 6-digit code, 15-min, single-use, either credential burns the other, 5 wrong code attempts kill it, built-in rate limits (request 3/email + 10/IP per 10 min; verify 10/email + 50/IP), 30-day httpOnly session cookie `onespends_session`, token hashes only in D1 |
| Client | `js/sync.js` (engine) + `js/sync-core.js` (pure merge logic) + account sheet in `app.html` / wiring in `js/app.js`; SW must never cache `/api/` (bypass at the top of sw.js's fetch handler) |

## Why a routed Worker, not Pages `_worker.js`

A `_worker.js` advanced-mode file was built and deployed first: the raw
assets-API direct-upload flow (pages-deploy-multi.py) treats it as a plain
static file — it was served at `/_worker.js` and never executed (docs: advanced
mode takes effect via git integration / Wrangler / dashboard drag-and-drop).
The zone-route Worker intercepts `/api/*` before Pages, so the site pipeline
is byte-for-byte the old one. The Pages project still carries a (now unused)
D1 binding from the attempt; the Pages-side `RESEND_API_KEY` secret was removed.

## Schema (`schema.sql`, applied to onespends-db)

- Lib tables verbatim: `magic_tokens`, `sessions`, `rate_limits`; `users`
  gains two nullable columns the lib never touches: `created_at`,
  `trial_ends_at`. On first successful verify the worker stamps
  `trial_ends_at = now + 90 days` (COALESCE — idempotent; standing rule:
  new apps get a 90-day full trial). No allowlist: any email creates an account.
- `spends` is an **append-only version log**: (seq AUTOINCREMENT, user_id,
  record_id, payload JSON, updated_at, deleted). A write is appended only
  when its `updated_at` beats the record's latest version — last-write-wins.
  Deletes are tombstone versions in the same log.

## API

- `POST /api/auth/request {email}` → mints link+code, sends ONE email (link → `https://onespends.dawnstudio.app/app?token=…`; the app redeems it via verify-link and scrubs the URL).
- `POST /api/auth/verify {email, code}` → session cookie.
- `POST /api/auth/verify-link {token}` → session cookie.
- `GET /api/auth/me` → `{email, trialEndsAt, plan}` (`plan`: `trial` | `free`) or 401.
- `POST /api/auth/logout`.
- `GET /api/sync?since=<seq>` → `{records:[{recordId, updatedAt, deleted, data}], cursor}` (own rows only).
- `PUT /api/sync {records:[...]}` → per-record validate + LWW append; `{accepted, skipped, rejected, cursor}`.
- Sync endpoints 403 `{error:"trial-ended"}` once the trial is over: the
  client pauses, shows the banner, deletes nothing. No billing exists yet;
  when it does, `plan` is where "paid" plugs in.

## Sync semantics (client)

- Records gained `updatedAt` in IndexedDB (stamped in `js/db.js` on every
  local write; legacy rows fall back to `createdAt`). Local deletes leave a
  tombstone in localStorage (`onespends_tombstones:onespends`) until pushed.
- On sign-in: push everything the server hasn't acknowledged, then pull
  from the saved cursor and apply per-record LWW (tombstone deletes a
  not-newer local copy; a newer local copy survives and re-pushes).
- Afterwards: auto-sync (debounced) on every local change, on load, on
  `online`, on visibility return. Manual 立即同步 button in the account sheet.
- Sign-out: sync stops; local data untouched. A *different* account signing
  in on the same device resets the sync cursor/bookkeeping (local records
  stay and merge into that account).
- Demo DB / tour preview: sync is disabled (`enabled()` gate in app.js).

## Redeploy

Worker (after editing `src/worker.js` or bumping dawn-auth):

```sh
cd ~/workspace/onespends-worker
node build.mjs                 # esbuild bundle → dist/worker.js
node test/worker.test.mjs      # local harness: node:sqlite fake D1 + Resend stub (13 checks)
python3 tools/deploy-worker.py # mints a fresh Resend key, uploads script + secret, ensures route
```

Site (any client change):

```sh
cd ~/workspace/onespends-worker && node build.mjs   # not needed for site-only changes
cd ~/workspace/onespends
# bump SW: CACHE name in sw.js + ?v=N in all *.html (house ritual), then:
PAIRS=$(find . -type f -not -path './tests/*' | sed 's|^\./||' | while read f; do printf '%s=/%s ' "$f" "$f"; done)
python3 ~/workspace/pages-deploy-multi.py onespends $PAIRS
```

D1 ad-hoc SQL: `python3 ~/workspace/onespends-worker/tools/d1-sql.py "SELECT …"`
(schema re-apply: same tool with `--file schema.sql`; statements are idempotent).

## Tests

- `~/workspace/onespends/tests/parser.test.mjs` — 82/82 (unchanged by this feature).
- `~/workspace/onespends/tests/sync-core.test.mjs` — merge planner: LWW, tombstones, first-merge, push diffing (6 checks).
- `test/worker.test.mjs` — the bundled worker end-to-end locally (13 checks).
- `test/e2e-live.py` / `test/e2e-live-continue.py` — the 2026-10-26 live run
  (one real magic email to the owner; code recovered from D1's code_hash —
  test-only; all test rows purged afterwards). Do not re-run casually: each
  full run sends a real email.
