# Botwa

Self-hosted customer-support hub: staff log in to a web panel, link WhatsApp / Telegram accounts by **QR scan**, and handle customer conversations. No external AI APIs.

Status: **feature-complete** (MVP + attachments, reports, live updates, privacy tooling) (API, Hebrew/RTL panel, WhatsApp + Telegram QR). Deployment guide: [docs/DEPLOY.md](docs/DEPLOY.md). Pre-production list: [docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md). Real WhatsApp/Telegram pairing must still be tested manually with phones. See [PLAN.md](PLAN.md) for scope and roadmap.

## Requirements
Ubuntu server, Node 22+, PostgreSQL 16 (or Docker), HTTPS reverse proxy (Caddy/Nginx).

## Run locally
```bash
npm install
cp .env.example .env        # fill DATABASE_URL, ENCRYPTION_KEY (openssl rand -base64 32), APP_ORIGIN
cd apps/server
ADMIN_EMAIL=you@example.com ADMIN_NAME="You" ADMIN_PASSWORD='min-12-chars-long' npm run create-admin
npm run dev
```
## Web panel
```bash
npm run build -w @botwa/web     # API serves apps/web/dist automatically (same origin, no CORS)
# dev: terminal 1 `npm run dev -w @botwa/server`, terminal 2 `npm run dev -w @botwa/web` (http://localhost:5173)
#      set APP_ORIGIN=http://localhost:5173 and COOKIE_SECURE=false in .env for dev
```
Restart the API after rebuilding the web assets (file list is read at startup).

## End-to-end & accessibility test
```bash
# start the server against a scratch DB with an admin admin@e2e.io / e2e-password-123 on :3077, then:
npm test -w botwa-e2e        # Playwright (Chromium) + axe-core; set CHROME_PATH if needed
```
Automated checks do not replace manual screen-reader testing (NVDA/VoiceOver) and an accessibility consultant review.

## Docker (Ubuntu)
See [docs/DEPLOY.md](docs/DEPLOY.md) (Compose: Postgres + app + Caddy with automatic HTTPS, backups, restore).

## Documentation
- docs/ROADMAP.he.md: researched feature proposals (not yet built)
- [docs/DEPLOY.md](docs/DEPLOY.md) – install on Ubuntu (Compose + Caddy HTTPS), backup/restore
- [docs/USER_GUIDE.he.md](docs/USER_GUIDE.he.md) – staff guide (Hebrew)
- [docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md) – pre-production checks, personal-data table, cookies, risks
- [docs/legal/](docs/legal/README.md) – DRAFT privacy policy, cookies, internal-use policy, accessibility statement (lawyer review required)
- [docs/DATA_REQUESTS.he.md](docs/DATA_REQUESTS.he.md) – handling access/erasure requests

## Tests
```bash
createdb botwa_test
TEST_DATABASE_URL=postgres://user:pw@localhost:5432/botwa_test npm test -w @botwa/server
```
Tests **drop and recreate the public schema** of the test DB – never point them at real data.

## API (P1)
Public: `POST /auth/login`, `GET /healthz`
Authenticated: `POST /auth/logout`, `GET /auth/me`, `POST /auth/password`, `POST /auth/mfa/setup|enable`
Admin: `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-mfa`, `GET /audit` (supervisor may list users)

## API (P2)
Admin: `GET/POST /channels`, `POST /channels/:id/start|stop|logout|password` (`start` accepts `{"phone":"9725…"}` for WhatsApp pairing-code linking instead of QR) (password = Telegram 2FA during QR login), `DELETE /channels/:id`, `GET /channels/:id/events` (SSE: status + QR data-URL), `GET /contacts/:id/export`, `DELETE /contacts/:id`
Staff (all roles): `GET /conversations`, `GET /conversations/:id/messages`, `POST /conversations/:id/messages|read|assign|status`
Blocking customers: `POST /contacts/:id/block|unblock` (supervisor/admin), `GET /conversations?blocked=true`; flood auto-block (`FLOOD_LIMIT`). Ban avoidance ("good citizen" behaviour, no identity spoofing): reply window (staff may answer only customers who wrote within N hours), opt-out ("הסר"/stop => no automatic or staff messages until they write again; `POST /contacts/:id/opt-in`), automatic pause after repeated send failures, manual emergency pause `POST /channels/:id/pause|resume`, read receipts on opening a chat, risk level per channel in `GET /channels/health`. Anti-ban pacing: `GET/PUT /settings/sending` (min/max delay, per-minute and per-day caps, warm-up for new numbers, typing indicator), 429 `send_throttled|daily_limit|queue_full`; `GET /channels/health` (usage vs cap, warnings, recent status events); restriction/ban detection (WhatsApp 403, Telegram PEER_FLOOD/…BAN) -> status `restricted`, auto-start off, optional `ALERT_WEBHOOK_URL`.
Menu bot: `GET/PUT /settings/bot` (admin writes; numbered menu, answers, "0"/keywords = human, unknown input -> menu again N times then hand-over; conversation `bot_state` menu|human; no AI). Routing: `GET/PUT /settings/routing` (`off|round_robin|least_busy`, admin writes), `POST /auth/availability`. CSV: `GET /reports/export.csv?kind=agents|daily&days=`. In-conversation search `GET /conversations/:id/messages?q=`, `GET /conversations/:id/related`. Backups (admin): `GET/POST /backups`, `GET/DELETE /backups/:name` (encrypted, restore via `node dist/scripts/decrypt-backup.js`).
Tags: `GET /tags`, `POST/DELETE /tags` (supervisor/admin), `POST/DELETE /conversations/:id/tags[/:tagId]`, filter `GET /conversations?tag=`. Settings: `GET/PUT /settings/business-hours` (admin writes; out-of-hours auto reply, max once per 12h per conversation, marked `auto`). Audit: `GET /audit?action=<prefix>&before=<id>&limit=` (admin). Conversation list also returns `tags` and `waitingSince`.
Live updates: `GET /events` (SSE, content-free "conversation X changed" events, filtered by the user's access).
Also: `GET /conversations?q=` (search name/number/message text), `GET/POST /conversations/:id/notes` (internal notes, never sent to customers), `GET /canned-replies` (all staff), `POST/DELETE /canned-replies` (supervisor/admin).
Reports (supervisor/admin): `GET /reports/summary?days=` – volumes, response times per agent, daily series (no message content; `REPORT_TZ`, default Asia/Jerusalem).
Agents see only conversations assigned to them or unassigned; supervisors/admins see all.

## API (P17: roles, passkeys, unread)
- `GET/POST /roles`, `PATCH/DELETE /roles/:key` – custom roles (permissions list; `roles.manage`; built-in roles are immutable; a role cannot grant permissions its editor lacks).
- `POST /auth/passkeys/register/options|verify` (logged in), `POST /auth/passkeys/login/options|verify` (public, rate limited), `GET /auth/passkeys`, `DELETE /auth/passkeys/:id`. Needs HTTPS (or localhost); optional `WEBAUTHN_RP_ID` overrides the RP ID derived from `APP_ORIGIN`.
- `GET /conversations/unread` – `{count}` of open conversations visible to the caller (drives the badge and tab title).

## Attachments (images, PDF, Word/Excel, audio, MP4)
Disabled unless an antivirus daemon is configured (`CLAMAV_HOST`; Docker: `docker compose --profile media up -d` and `CLAMAV_HOST=clamav`). Fail-closed pipeline: file type decided by **content** allowlist (not name/MIME; SVG/HTML/exe/archives blocked) -> stored under a random id in `MEDIA_DIR/quarantine` (0600, outside any web root) -> ClamAV INSTREAM scan -> moved to `clean/` only if OK; infected files are deleted and audited. Files are served only when `clean`, behind login + the conversation's access rules, with `nosniff`, `CSP: sandbox`, and `attachment` disposition for everything except images. Staff uploads are scanned *before* being sent to the customer. If the scanner is down, inbound files stay pending (retried every minute) and uploads return 503.
API: `GET /attachments/:id`, `POST /conversations/:id/attachments` (multipart: `file`, optional `caption`).
Retention/erasure/channel deletion also delete the files on disk.

## Linking WhatsApp (manual)
1. Create a channel (`POST /channels {type:"whatsapp",label}`), 2. open `GET /channels/:id/events` (SSE) and `POST /channels/:id/start`, 3. render the `qr` data-URL, scan from WhatsApp → Linked devices. Session is stored encrypted in PostgreSQL; the channel auto-starts on server boot.
**Risk:** uses the unofficial Baileys library (ToS violation, number may be banned). Back up the DB and `ENCRYPTION_KEY` – losing the key means re-scanning.

## Data retention & privacy
Messages older than `MESSAGE_RETENTION_DAYS` are purged daily. Admin can export/erase a contact. Privacy policy / DPA / database-registration questions require legal review.

## Security notes
argon2id passwords, TOTP secrets encrypted AES-256-GCM, server-side sessions (hashed token, HttpOnly+SameSite=Strict cookie), Origin check on mutations, per-IP rate limit + per-account lockout, audit log, no secrets in logs. Draft only – requires independent security review before production.
