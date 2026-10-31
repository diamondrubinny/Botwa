# Botwa – Self-Hosted Bot Manager (WhatsApp + Telegram QR Login)

> Status: **Approved. P0–P5 implemented. Next: deploy to the Ubuntu server (docs/DEPLOY.md) and manually test WhatsApp + Telegram pairing with real phones.**
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
- Done in P22: knowledge base (no AI): FAQ/text/file(PDF, DOCX, TXT, MD, CSV, HTML)/link sources with optional same-site crawl and scheduled refresh; Postgres full-text search with Hebrew prefix handling, synonyms, scoring and confidence threshold; bot answers free-text questions from it (never over menu numbers or handoff requests), agent suggestions in the chat with feedback, playground, unanswered-question gaps, stats, categories, audience (bot/staff), boost. Security: SSRF-safe fetch (connect-time IP check), isolated worker with memory/time limits for parsing, ClamAV on binary files, retention for the question log. 153 server tests + E2E. Not built: OCR, robots.txt, semantic search.
- Done in P21: official WhatsApp channel (Cloud API) as an additional channel type next to Baileys (Baileys is kept): HMAC-signed webhook, encrypted credentials, Graph send/media/read, 24h window enforced server-side, policy rejections never auto-pause, media-host allow-list, pacing/warm-up skipped for the official API. 141 server tests + E2E. Not built: templates, interactive sends. Needs verification against Meta docs and a real number.
- Done in P20: backup restore rehearsal: `POST /backups/:name/verify`, "בדיקת תקינות" button, `scripts/verify-backup`, automatic verification after the daily backup (logged as error if unusable). Wrong key / tampered / truncated backups are detected. 136 server tests.
- Done in P19 (roadmap approved): snooze (wakes on new customer message), personal stars, mark-unread; Web Push (VAPID keys generated and stored encrypted, endpoint allow-list against SSRF, content-free alerts, unsubscribe at logout, stale subscriptions pruned); reports: busiest hours + top tags. Already existed: daily encrypted backup (BACKUP_AUTO_HOUR) and content search in the inbox. Not built: pg_trgm index (needs extension privileges), restore-test command. 135 server tests + E2E.
- Done in P18: eye-friendly "soft" warm-paper theme (new default when the device is in light mode; 270 contrast checks), per-conversation drafts (sessionStorage, no leak between chats), `/` canned-reply menu in the composer, optional generic background-tab notification (no message content). Still not built: Web Push.
- Done in P17: passkeys (WebAuthn, discoverable, UV required, counts as MFA, needs HTTPS + RP ID = domain), custom roles with permission checkboxes (no escalation, last-admin guard, built-ins immutable), redesigned light/dark theme + 5 accents + high contrast (180 contrast checks), mobile-first agent UX (bottom nav, full-screen chat, sticky composer, quick chips, unread badge `/conversations/unread`), installable PWA (shell-only service worker, never caches API). 132 server tests + E2E (virtual authenticator, 390px phone checks, axe on 10 theme combinations). Not built: Web Push.
- Done in P16: more ban avoidance: reply window (no unsolicited outbound), opt-out handling, auto-pause after failures + manual emergency pause, read receipts, risk level + panel controls. 113 server tests + E2E. Deliberately NOT built: fingerprint/identity spoofing, proxy rotation or other detection evasion.
- Done in P15: customer blocking (manual + flood auto-block, silent evidence storage), anti-ban send pacing (per-channel lane, random spacing, per-minute/day caps, new-number warm-up, typing indicator), channel health panel + events, restriction/ban detection with webhook alert, canned-reply {שם} placeholder. 101 server tests + E2E. **Cannot guarantee against bans: unofficial clients.**
- Done in P14: menu bot (numbered menu + answers, human hand-over by "0"/keyword/unknown input/file, notes, routing, away notice, loop guard, bot-aware inbox list) + admin UI page. 87 server tests + E2E.
- Done in P13: WhatsApp phone-number pairing code (no QR; for single-device users), phone-only install path (bootstrap.sh + token one-paste), wizard. **Pairing code uses Baileys requestPairingCode – verified against its typings only, not against real WhatsApp.**
- Done in P12: auto-routing (round-robin/least-busy, on-duty toggle, advisory-locked), CSV report export (formula-injection safe), in-conversation search + same-customer-other-channel panel, encrypted DB backups in the admin panel (+ decrypt CLI, daily schedule option). 72 server tests + full E2E.
- Done in P11: audit-log UI (filters, pagination), conversation tags (+filter), business hours + out-of-hours auto reply (loop-safe, excluded from response-time reports), waiting-time/SLA highlight in inbox, settings page. 60 server tests + full E2E.
- Done in P10: live inbox updates (SSE, no content, access-filtered), tab-title unread count, admin export/erase buttons (found gap: erase was API-only), DRAFT legal pack (docs/legal), data-request procedure, staff guide. 54 server tests + full E2E.
- Done in P9: supervisor reports (volumes, response time per agent, daily table) + independent security review and fixes (see PRODUCTION_CHECKLIST). 53 server tests (incl. real clamd) + E2E incl. MFA enforcement.
- Done in P8: media (inbound+outbound) with quarantine + content allowlist + ClamAV scan, fail-closed, secure serving, disk cleanup on retention/erase/delete; UI bubbles + upload; compose `media` profile. 46 server tests (incl. a REAL clamd run with EICAR) + E2E. Also fixed: blank optional env vars (`KEY=`) used to crash startup.
- Done in P7: internal notes, canned replies (manager-curated), conversation search (escaped ILIKE). 27 server tests; E2E extended. Fixed build script (stale dist/migrations nesting on rebuild).
- Done in P5: Telegram user-account QR adapter (gramJS) incl. 2FA password step (in-memory, never stored), QR refresh, 3-minute scan window, revoked-session detection, contact id = userId:accessHash so replies work after restarts. Requires TELEGRAM_API_ID/HASH. **Could not be exercised against real Telegram servers from the dev sandbox (network blocked).**
- Done in P6 (partial): docs/DEPLOY.md, docker-compose with Caddy auto-HTTPS, scripts/backup.sh, docs/PRODUCTION_CHECKLIST.md. Docker image build itself was not run (no daemon); production-dependency install + boot was simulated instead.
- Done in P3: React+Vite admin panel (Hebrew, RTL, hash-routed, served by the API on the same origin): login+MFA, forced MFA enrolment for admin/supervisor, channels + live QR link screen, inbox (list/filter/reply/claim/assign/close), team management, account/password, accessibility statement + privacy page (both DRAFTS), accessibility widget. Playwright+axe-core E2E (e2e/) passes: 0 WCAG 2.1 A/AA violations on all screens, keyboard dialog, mobile 375px no h-scroll.
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
