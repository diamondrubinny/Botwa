# Botwa

Self-hosted customer-support hub: staff log in to a web panel, link WhatsApp / Telegram accounts by **QR scan**, and handle customer conversations. No external AI APIs.

Status: **P0–P3 done** (API + Hebrew/RTL admin panel). Telegram QR is next. WhatsApp pairing must be tested manually with a real phone. See [PLAN.md](PLAN.md) for scope and roadmap.

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
```bash
cp .env.example .env   # set DATABASE_URL=postgres://botwa:<DB_PASSWORD>@db:5432/botwa
export DB_PASSWORD=...  # same value
docker compose up -d --build
docker compose exec server node -e "..."   # or run create-admin via npm in a one-off container
```
Put Caddy/Nginx in front with HTTPS; keep port 3000 bound to localhost.

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
Admin: `GET/POST /channels`, `POST /channels/:id/start|stop|logout`, `DELETE /channels/:id`, `GET /channels/:id/events` (SSE: status + QR data-URL), `GET /contacts/:id/export`, `DELETE /contacts/:id`
Staff (all roles): `GET /conversations`, `GET /conversations/:id/messages`, `POST /conversations/:id/messages|read|assign|status`
Agents see only conversations assigned to them or unassigned; supervisors/admins see all.

## Linking WhatsApp (manual)
1. Create a channel (`POST /channels {type:"whatsapp",label}`), 2. open `GET /channels/:id/events` (SSE) and `POST /channels/:id/start`, 3. render the `qr` data-URL, scan from WhatsApp → Linked devices. Session is stored encrypted in PostgreSQL; the channel auto-starts on server boot.
**Risk:** uses the unofficial Baileys library (ToS violation, number may be banned). Back up the DB and `ENCRYPTION_KEY` – losing the key means re-scanning.

## Data retention & privacy
Messages older than `MESSAGE_RETENTION_DAYS` are purged daily. Admin can export/erase a contact. Privacy policy / DPA / database-registration questions require legal review.

## Security notes
argon2id passwords, TOTP secrets encrypted AES-256-GCM, server-side sessions (hashed token, HttpOnly+SameSite=Strict cookie), Origin check on mutations, per-IP rate limit + per-account lockout, audit log, no secrets in logs. Draft only – requires independent security review before production.
