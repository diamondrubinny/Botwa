# Pre-production checklist

Status legend: ✅ done in code/tests · 🔲 must be done by the operator · ⚖️ needs professional sign-off.

## Functional
- ✅ Auth, MFA, lockout, sessions (24 automated server tests, Playwright E2E)
- ✅ Inbox: receive, reply, claim/assign/close, dedupe
- 🔲 Real WhatsApp pairing, receive + send, restart persistence (cannot be tested without a phone)
- 🔲 Real Telegram QR pairing (+2FA password path), receive + send, restart persistence
- 🔲 Load sanity: ~4000 contacts, 19 staff polling every 3–5s is low volume; verify with real data

## Authorization & sessions
- ✅ Server-side checks on every endpoint; agents limited to own/unassigned conversations (404 on others – IDOR tested)
- ✅ Admin-only: channels, QR stream, user management, export/erase, audit
- ✅ Sessions revoked on password change, MFA change, deactivate, role change
- 🔲 Manual review: create one user per role and walk through the UI

## Security
- ✅ argon2id, AES-256-GCM for TOTP secrets and platform sessions, HttpOnly+SameSite=Strict cookies, Origin check, rate limits, helmet/CSP, no secrets in logs
- ✅ `npm audit --omit=dev`: 0 known vulnerabilities at time of writing (re-run before each release)
- 🔲 `.env` is `chmod 600`, not in git; `ENCRYPTION_KEY` backed up separately
- 🔲 SSH key-only, firewall (ufw) enabled, unattended-upgrades on
- 🔲 Postgres port not published (compose does not publish it) ✔ verify with `ss -ltnp`
- ⚖️ Independent penetration test (recommended before storing real customer data)
- ✅ Attachments: content-based type allowlist, size limit (`MEDIA_MAX_MB`), random storage names, quarantine → ClamAV scan → clean, infected deleted + audited, never served unless clean, sandbox/nosniff headers, scan-before-send for staff uploads, fail-closed when scanner down/unset (tested incl. a real clamd daemon)
- 🔲 Attachments in production: `--profile media` is up and `clamav` is healthy; signatures are current (`docker compose logs clamav | grep -i database`); send a real photo and a PDF from a phone and confirm both arrive as `clean`
- Known limitations: AV is signature-based (no zero-day guarantee); PDF/Office files are offered as downloads and can still be malicious to open on a workstation – train staff, keep endpoints protected; images are not re-encoded; files are stored unencrypted on the `media` volume (encrypt the disk/volume at rest); voice/video are not transcoded or previewed.
- 🔲 Back up the `media` volume together with the database; retention deletes files together with messages
- ✅ Independent code-level security review (separate reviewer, read-only, traced end to end): no high-severity issues; the medium/low findings were fixed with regression tests: atomic lockout counter (race-proof), server-side MFA enforcement for admin/supervisor, locked accounts indistinguishable from wrong password, inbound-media quotas + concurrency cap, scan/claim races. This is NOT a penetration test.
- Known limitation: login rate limit is per IP (in-memory, single process); account lockout is per account (DB). A known email can still be locked out for 15 minutes by an attacker (the response no longer reveals it, but the legitimate user is affected; admin can see `login.lockout` in the audit log).
- Known limitation: inbound media is fully buffered in memory during download (bounded by `MEDIA_MAX_MB` and max 4 concurrent).

## Auto reply (out of hours)
- ✅ Loop-safe: only triggered by a customer message, max once per conversation per 12h, stored as `auto` (not counted as a human response in reports)
- ⚖️ Confirm wording with counsel (it is an automatic message to a customer); keep it informational, not promotional
- 🔲 Test with a real number outside hours; note that any outbound automation raises the WhatsApp/Telegram ban risk slightly

## Routing, exports, backups (added later)
- ✅ Auto-routing serialised with an advisory lock (tested with concurrent burst), only on-duty `agent` role; CSV export guards spreadsheet-formula injection; encrypted backups (tamper + wrong-key detection tested against real pg_dump)
- 🔲 Docker image: confirm `pg_dump --version` inside the server container matches the DB major version (16) and that "create backup" works from the panel
- 🔲 Restore rehearsal from a panel-made backup into an empty database (CLI only) – see DEPLOY.md
- Known limitation: backups are not incremental and do not include the `media` volume; the encryption key is derived from `ENCRYPTION_KEY` (lose the key = lose the backups)
- Known limitation: related-conversation matching only works for WhatsApp phone-number ids (not WhatsApp LID or Telegram ids)

## Menu bot
- ✅ Deterministic rules only (no AI/third party); loop guard (>=8 automatic replies in 10 min => silent hand-over); stops when a person replies/assigned; closing resets
- ⚖️ Wording of bot messages and the hand-over notice (automatic messages to customers) – confirm with counsel; the privacy policy draft should mention automated replies
- 🔲 Test with a real number: first message, an answer, invalid input twice, "0", a photo, outside business hours
- Note: every automatic outbound message slightly increases the WhatsApp/Telegram ban risk; keep answers short

## Account-ban risk (WhatsApp/Telegram) and abuse
- ✅ Mitigations in code: per-channel paced sending, per-minute/day caps, new-number warm-up, typing indicator, bot/away loop guards, restriction detection (WhatsApp 403, Telegram PEER_FLOOD/..._BAN) that stops reconnecting, health panel, optional webhook alert; flood auto-block and manual blocking of abusive customers (evidence kept)
- ✅ Also: reply-only policy window, opt-out handling, auto-pause after failures, manual emergency pause, read receipts, risk level. Not implemented on purpose: device/fingerprint spoofing, proxy rotation or any other detection evasion (that would be evading the platforms' abuse controls)
- ⚠️ **These reduce, not remove, the risk.** The clients are unofficial and violate the platforms' terms; a ban can happen at any time regardless of pacing. Use a dedicated number, tell customers an alternative contact channel, keep backups of the contact list, never use it for bulk/marketing messages, and consider the official WhatsApp Business Cloud API for the long term.
- 🔲 Keep defaults (perDay 500, perMinute 12) or lower them; keep warm-up on for new numbers; watch the health panel daily during the first weeks
- 🔲 Set `ALERT_WEBHOOK_URL` (e.g. a Slack/Discord channel) so a logout/restriction is noticed quickly
- Blocking is internal only (the customer is not blocked on the platform and is not notified)

## Backup & recovery
- 🔲 Daily `scripts/backup.sh` cron + off-server copy + GPG encryption
- 🔲 Restore rehearsal on a scratch database (documented in DEPLOY.md)

## Personal data inventory
| Data | Purpose | Legal basis (to confirm) | Storage | Retention | Third parties |
|---|---|---|---|---|---|
| Staff name, email, role | Authentication, audit | Contract / legitimate interest | PostgreSQL | While employed | None |
| Staff password hash, TOTP secret (encrypted) | Authentication | Legitimate interest (security) | PostgreSQL | While employed | None |
| Audit log (actor, action, IP) | Security & accountability | Legitimate interest | PostgreSQL | Not auto-purged ⚠️ define policy | None |
| Customer phone/Telegram id, display name | Customer support | Contract / legitimate interest | PostgreSQL | With conversation | WhatsApp (Meta), Telegram as transport |
| Attachments (images, documents, voice, video) | Customer support | Contract / legitimate interest | `media` volume on server disk, unencrypted at file level | With the message (`MESSAGE_RETENTION_DAYS`), deleted on erase | ClamAV runs locally (no file leaves the server) |
| Message text (in/out) | Customer support | Contract / legitimate interest | PostgreSQL (not field-encrypted) | `MESSAGE_RETENTION_DAYS` (default 365) | WhatsApp (Meta), Telegram |
| WhatsApp/Telegram session keys | Operate channel | n/a (credentials) | PostgreSQL, AES-256-GCM | Until logout/delete | None |
- Not sent to any AI, analytics or advertising service.
- Data-subject requests: admin export/erase per contact (`/contacts/:id/export|DELETE`). 🔲 Define an operational procedure & response time.
- ⚖️ Israel Privacy Protection Law + Amendment 13: database registration / DPO / security-level obligations, notice to customers that conversations are recorded. GDPR if EU residents are served (DPA with Meta/Telegram terms, international transfers).
- ⚖️ WhatsApp & Telegram Terms of Service: unofficial clients are not permitted; risk of number/account ban accepted by owner.
- ⚖️ Israeli Communications Law §30A (spam) if any outbound marketing is ever added – current product is reply-to-inbound only.

## Cookies / trackers
| Name | Type | Purpose | Duration | Consent |
|---|---|---|---|---|
| `botwa_sid` | First-party, HttpOnly | Login session | `SESSION_TTL_HOURS` (12h) | Not required (strictly necessary) |
| `localStorage botwa_a11y` | First-party storage | Accessibility preferences | Until cleared | Not required (user-requested function), never sent to server |
- No analytics, pixels, fonts or scripts from third parties. If any are added: consent banner (accept/reject/manage, reject as prominent as accept), blocking before consent, withdrawal link in footer.

## Accessibility
- ✅ Automated axe-core (WCAG 2.1 A/AA) passes on all screens incl. high-contrast mode; keyboard dialog; 375px mobile
- 🔲 Manual: keyboard-only walkthrough, NVDA/VoiceOver, 200% zoom, real mobile devices
- ⚖️ Accessibility consultant review vs. Israeli Standard 5568 / WCAG 2.1 AA; complete the accessibility statement (coordinator name, contact, date)

## Legal documents (drafts in-app, marked as drafts)
- ⚖️ Privacy policy – `#/privacy` is a technical draft only
- ⚖️ Cookie policy – covered inside the privacy draft (essential cookie only)
- ⚖️ Terms of use – not written yet (internal tool: employment/IT-usage policy may be more appropriate)
- ⚖️ Accessibility statement – `#/accessibility` draft, placeholders must be completed

## Requires professional approval before go-live
Lawyer (privacy, ToS risk, employee monitoring/notice) · Privacy officer (if required) · Accessibility consultant · Penetration tester.

## Passkeys, roles, PWA (P17)
- [ ] Passkeys: served over HTTPS; RP ID equals the site domain (apex shared with www). Set `WEBAUTHN_RP_ID` only if the panel moves to another subdomain. Changing the domain invalidates existing passkeys.
- [ ] Test passkey registration and login on a real phone and a real desktop browser (automated tests use a virtual authenticator only).
- [ ] Review custom roles: keep `settings.manage`, `roles.manage`, `users.manage`, `backups.manage`, `privacy.manage` limited to admins; roles with `mfaRequired` need TOTP or a passkey.
- [ ] Verify the PWA install and phone layout on real iOS and Android devices.

## Web Push (P19)
- [ ] HTTPS and a valid certificate (push does not work on plain HTTP except localhost).
- [ ] Add push devices to the personal-data map: endpoint + keys per device, deleted at logout, user removal and when the push service reports the subscription expired. Mention in the privacy policy draft (lawyer review).
- [ ] Changing `ENCRYPTION_KEY` invalidates the VAPID private key: the server regenerates it and drops all subscriptions, so staff must re-enable alerts.
- [ ] Test on a real Android and a real iPhone (iOS needs the installed home-screen app).

## Official WhatsApp channel (P21)
- [ ] Verify every Meta-specific detail (API version, 24h window, error codes, pricing, template rules) against the current official documentation.
- [ ] Real end-to-end test with a verified business number (inbound text/media, reply, read receipt, expired-token behaviour). Only simulated Meta responses were tested.
- [ ] Reverse proxy passes `/webhooks/` unchanged over HTTPS; no WAF rule blocks Meta's POSTs.
- [ ] Add Meta (WhatsApp) to the data map and privacy policy draft; check DPA / international transfer (lawyer).
- [ ] Rotate the access token and app secret on staff changes; they are write-only in the panel.

## Knowledge base (P22)
- [ ] ClamAV running (needed for PDF/DOCX; without it those uploads are refused by design).
- [ ] Review what is uploaded: customer-facing content only. Mark internal material "נציגים בלבד".
- [ ] Add the question log (customer text, short retention `KB_QUERY_RETENTION_DAYS`) to the data map and privacy policy draft (lawyer).
- [ ] Only add sites you may copy (terms of use / copyright). The crawler does not read robots.txt.
- [ ] Test the bot answers with real phrasing from your customers; tune the confidence threshold and synonyms.
- [ ] Outbound HTTPS from the server must be allowed for links (private addresses are blocked on purpose).

## Meaning search and flow chart (P24)
- [ ] If enabled (WITH_SEMANTIC=1, SEMANTIC_SEARCH=local): the Docker build with the optional runtime was NOT run in this environment. Build once and check `docker compose logs server`, `/kb/semantic` status (ready), RAM (~400MB extra) and disk (~0.5GB).
- [ ] The server needs outbound HTTPS to huggingface.co once to download the model (or pre-populate the `models` volume). Verify the model licence for your use.
- [ ] Test with real customer phrasings in "בדיקת חיפוש": tune the bot's confidence threshold. The model separates topics well but cannot tell "unanswerable" by itself; keep the threshold conservative.
- [ ] Flow chart: run the "בדיקה בשיחה" for every branch (open/closed hours, each channel, unknown input, files) before switching the bot mode.
- [ ] Flow questions collect personal data (name, phone, email): state the purpose in the privacy policy draft; the answers are stored as an internal note on the conversation (retention follows message retention).

## Website chat widget (P25)
- [ ] The server is reachable from the public internet over HTTPS (widget.js, /w/*, /widget/* are public by design). A reverse proxy must not add `X-Frame-Options` to `/w/*` (the app sets frame-ancestors itself) and must pass the `Authorization` header.
- [ ] List only the real site origins in "אתרים מורשים". Avoid "any site".
- [ ] Test the widget on the real site in Chrome, Firefox and Safari/iOS (only Chromium was tested). Check storage partitioning and any CSP on the host site (it needs `script-src` for this server and `frame-src` for this server).
- [ ] Privacy: wording of the consent line, what the form collects, retention, and the localStorage token in the site's cookie/storage policy (lawyer).
- [ ] If the site has signed-in customers and identity is used: the signature is computed on the site's server only; rotate the secret if it leaks.

## API and webhooks (P26)
- [ ] Create keys per integration with the minimum scope; revoke unused ones. Keys are secrets.
- [ ] Webhook receivers must verify the signature and the timestamp and tolerate duplicates.
- [ ] Message text sent to webhooks is personal data: decide per endpoint (`includeText`), record the receiving system in the data map and privacy policy (lawyer).
- [ ] The server needs outbound HTTPS for webhooks; private addresses are blocked on purpose.

## WordPress plugin (P27)
- [ ] Install on a staging WordPress site first: the plugin was verified with a PHP test harness that stands in for WordPress, not on a real installation. Check: activation, settings save, "test connection", button visible, shortcode, logged-in recognition (if used), caching/optimisation plugins.
- [ ] Add every site (with and without www) to the chat's allowed sites in Botwa.
- [ ] Docker image: the build copies `wordpress-plugin/` (the download endpoint needs it); the Docker build itself was not run here.
- [ ] Privacy: the plugin's suggested privacy text and the consent mode need a legal review for each site.
