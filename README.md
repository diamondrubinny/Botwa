# Botwa

Self-hosted customer-support hub: staff log in to a web panel, link WhatsApp / Telegram accounts by **QR scan**, and handle customer conversations. No external AI APIs.

Status: **P0+P1 done** (server foundation, auth, MFA, users, audit). See [PLAN.md](PLAN.md) for scope and roadmap.

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

## Security notes
argon2id passwords, TOTP secrets encrypted AES-256-GCM, server-side sessions (hashed token, HttpOnly+SameSite=Strict cookie), Origin check on mutations, per-IP rate limit + per-account lockout, audit log, no secrets in logs. Draft only – requires independent security review before production.
