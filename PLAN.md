# Botwa – Self-Hosted Bot Manager (WhatsApp + Telegram QR Login)

> Status: **Approved. P0+P1+P2 implemented (apps/server). Next: P3 (web panel), then Telegram QR.**
> Working doc: all progress is tracked here (token-saving workflow).

## 1. Understanding
A self-hosted server with a web admin panel that:
1. Links WhatsApp (and Telegram) accounts by **QR scan**, from the panel.
2. Runs and manages bots on those sessions (start/stop, status, logs, message handlers).
3. Persists sessions securely so re-scan is not needed after restart.

## 2. Critical technical facts (verify against official docs before build)
| Platform | QR login reality | Notes |
|---|---|---|
| WhatsApp | QR "linked device" is only available via **unofficial** libs (e.g. Baileys / whatsapp-web.js). | **ToS violation risk → number can be banned.** Official alternative: WhatsApp Business Cloud API (no QR, template/24h-window rules, Meta business verification). |
| Telegram **Bot** | Bots do **not** use QR. They use a token from @BotFather. | Official, stable, zero ban risk. |
| Telegram **User account** | QR login exists in MTProto (`auth.exportLoginToken`), via gramJS / TDLib. Needs `api_id`/`api_hash` from my.telegram.org. | Userbots are allowed but automation abuse/spam leads to bans. *Needs verification.* |

Recommendation: build an **adapter interface** (`ChannelAdapter`) so each channel is pluggable; ship WhatsApp-QR (Baileys) + Telegram (Bot token first, User-QR via gramJS second) and keep WhatsApp Cloud API as a future adapter.

## 3. MVP scope
- Admin auth (single/multi admin) + MFA (TOTP) + rate limiting.
- Channels page: add WhatsApp / Telegram account → live QR (SSE/WebSocket) → status (connecting / connected / logged-out).
- Bot engine: per-channel session workers, simple rule/command handlers (plugins in TS), send/receive log.
- Encrypted session storage (AES-256-GCM, key from env), logout/delete-session.
- Audit log, health endpoint, Docker Compose deploy behind reverse proxy (HTTPS).
- Hebrew + RTL UI, WCAG 2.1 AA target.

Out of MVP: multi-tenant SaaS, billing, mass-messaging campaigns, media pipeline.

## 4. User stories (short)
- As admin I log in (password+TOTP) and see all linked accounts and their state.
- As admin I click "Link WhatsApp", scan the QR, and see "Connected" without reloading.
- As admin I start/stop a bot and see its live logs.
- As admin I revoke a session and its stored credentials are wiped.
- As admin I export/delete stored personal data (chat metadata) per retention policy.

## 5. Architecture
```
Browser (React, RTL) ──HTTPS──> Reverse proxy (Caddy/Nginx)
                                   │
                          API server (Node 20 + Fastify, TS)
                           ├─ Auth/RBAC, CSRF, rate-limit, audit
                           ├─ Channel Manager ──> ChannelAdapter[]
                           │     ├─ WhatsAppBaileysAdapter  (QR)
                           │     ├─ TelegramBotAdapter      (token)
                           │     └─ TelegramUserAdapter     (QR, gramJS)
                           ├─ Bot Engine (handlers/plugins, queue)
                           └─ Realtime (SSE: qr, status, logs)
                          PostgreSQL (Prisma) + Redis (optional, queue/rate-limit)
```
Why: Fastify+TS = fast, typed, schema validation (zod). Alternatives: NestJS (heavier), Python (Telethon strong for Telegram but Baileys is Node-only). Cost: unofficial WA lib breaks when WhatsApp changes protocol → maintenance burden.

## 6. Data model (draft)
- `admin(id, email, password_hash[argon2id], totp_secret_enc, role, created_at)`
- `channel(id, type[wa|tg_bot|tg_user], label, status, owner_admin_id, created_at)`
- `channel_session(channel_id, blob_enc, key_version, updated_at)`  ← encrypted creds
- `bot(id, channel_id, name, enabled, config_json)`
- `message_log(id, channel_id, direction, peer_hash, ts, meta)` – **no message bodies by default**, retention 30d
- `audit_log(id, admin_id, action, target, ip, ts)`

## 7. API (draft)
Public: `POST /auth/login`, `POST /auth/mfa`, `GET /healthz`
Protected (admin): `GET/POST/DELETE /channels`, `GET /channels/:id/qr/stream` (SSE), `POST /channels/:id/logout`, `GET/POST /bots`, `POST /bots/:id/start|stop`, `GET /bots/:id/logs/stream`, `GET /audit`
All: server-side authz on every resource (anti-IDOR), payload limits, zod validation.

## 8. Folder structure
```
botwa/
  apps/server/src/{auth,channels,adapters,bots,realtime,db,config}
  apps/web/src/{pages,components,i18n}
  packages/shared/   (zod schemas, types)
  docker-compose.yml  .env.example  README.md  PLAN.md
```

## 9. Threat model (short)
| Asset | Threat | Control |
|---|---|---|
| WA/TG session creds (= full account takeover) | DB leak, backup leak | AES-256-GCM at rest, key in env/secret mgr, no creds in logs |
| QR stream | Shoulder-surf / unauth viewer | Auth+MFA, short-lived SSE ticket, QR never stored, auto-expire |
| Admin panel | Brute force, CSRF, XSS | Rate limit, SameSite+HttpOnly+Secure cookies, CSP, HSTS |
| Bot handlers | Command injection / SSRF | Sandboxed plugins, no shell exec, URL allowlist |
| Account ban | Spam / ToS | Rate caps per channel, human-like delays, opt-in only |

## 10. Privacy / legal flags (need professional review)
Messages/phone numbers = personal data → Israeli Privacy Law (Amendment 13) & GDPR if EU users; possible database registration/DPO duties; WhatsApp/Telegram ToS; spam law (Israeli Communications Law §30A) for outbound marketing. Drafts of privacy policy/ToS/cookies/accessibility statement will be produced later and marked **draft – legal review required**. Panel uses only essential cookies (session/CSRF) → no consent banner needed unless analytics added.

## 11. Phases
1. **P0** Repo scaffold, config, Docker, CI, lint, README, `.env.example`.
2. **P1** Auth + MFA + audit + DB schema.
3. **P2** Channel manager + Telegram Bot adapter (simplest, validates architecture).
4. **P3** WhatsApp QR adapter + SSE QR UI + encrypted session store.
5. **P4** Bot engine + handlers + logs UI.
6. **P5** Telegram user QR adapter.
7. **P6** Hardening: tests, dependency scan, a11y audit, pre-prod checklist.

## 11a. Decisions (from user)
- WhatsApp: unofficial QR (Baileys), accepted ban risk. **No Claude/AI API** anywhere.
- Telegram: **user-account QR login** (gramJS). Bot-token adapter optional later.
- Purpose: **internal customer support** → shared inbox: conversations, assign to agent, internal notes, canned replies, per-agent permissions.
- Hosting: Ubuntu server (Docker Compose + Caddy/Nginx HTTPS) + admin panel.
- Stack (my call): Node 22 + TS + Fastify + PostgreSQL (plain SQL migrations) + React. Redis deferred (not needed at this scale).
- Scale: ~4000 customer contacts, 19 staff (roles: admin / supervisor / agent). Low concurrency → single server process is enough.
- Done in P2: channels + WhatsApp (Baileys) adapter with DB-backed encrypted session, live QR over SSE (admin only), inbox schema (contacts/conversations/messages), agent authz (own+unassigned only, 404 on others), reply/assign/close, retention purge (MESSAGE_RETENTION_DAYS), contact export/erase, auto-start on boot. 19 tests passing. **Real WhatsApp pairing not testable in CI – needs manual test on the server with a phone.**
- Done in P1: auth, MFA, lockout, sessions, users CRUD, audit, tests (9 passing).

## 12. Open questions (answered – see 11a)
1. **WhatsApp**: accept unofficial QR (Baileys) with ban risk, or prefer official Cloud API? (Or both, adapter-based.)
2. **Telegram**: bot token (BotFather) only, or also user-account QR login (userbot)?
3. **Purpose of the bot**: personal use / customer support / broadcast / auto-replies / AI? (affects legal + rate-limit design)
4. **Scale & hosting**: how many accounts, which server (VPS/Docker/home), domain + HTTPS available?
5. **Stack OK?** Node+TS+Fastify+Postgres+React, or other preference? Single admin or multiple users?

## 13. Pre-production checklist
Tracked later in `docs/PRODUCTION_CHECKLIST.md` (functional, authz, session, upload, secrets, deps, backup/restore, personal-data table, tracker list, a11y/RTL/mobile, legal sign-offs).

## Next step
Answer the 5 questions above (or say "go with recommendations") → I start **P0+P1**.
