-- A one-time code is accepted once: the time step of the last accepted TOTP code, so the same code cannot be replayed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;
-- Website chat: new visitor sessions are counted per address (a keyed hash of it, never the address itself) to stop one
-- address from filling the channel's hourly allowance.
ALTER TABLE webchat_visitors ADD COLUMN IF NOT EXISTS ip_hash text;
CREATE INDEX IF NOT EXISTS webchat_visitors_ip_idx ON webchat_visitors (ip_hash, created_at) WHERE ip_hash IS NOT NULL;
