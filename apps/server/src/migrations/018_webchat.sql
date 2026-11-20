-- Website chat widget channel.
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('whatsapp', 'whatsapp_cloud', 'telegram', 'webchat'));

-- monotonically increasing cursor for "messages after X" (message ids are random uuids)
ALTER TABLE messages ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX messages_seq_idx ON messages (conversation_id, seq);

CREATE TABLE webchat_configs (
  channel_id          uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  public_key          text NOT NULL UNIQUE,                 -- appears in the embed code; not a secret
  identity_secret_enc text NOT NULL,                        -- HMAC secret (encrypted) for verified customer identity
  allowed_origins     text[] NOT NULL DEFAULT '{}',         -- sites allowed to embed the widget (also enforced by CSP frame-ancestors)
  allow_any_origin    boolean NOT NULL DEFAULT false,
  design              jsonb NOT NULL DEFAULT '{}',
  behavior            jsonb NOT NULL DEFAULT '{}',
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- one row per browser that chatted; the token (hashed here) is the visitor's only credential
CREATE TABLE webchat_visitors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id   uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  identity_id  text,                                        -- set only when the host site proved it with a valid signature
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webchat_visitors_seen_idx ON webchat_visitors (last_seen_at);
