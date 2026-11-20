-- API keys (machine access) and outgoing webhooks (events pushed to other systems).
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  prefix       text NOT NULL,                       -- first characters of the key, shown in lists to tell keys apart
  key_hash     text NOT NULL UNIQUE,                -- sha256 of the full key; the key itself is shown once and never stored
  scopes       text[] NOT NULL,                     -- read | send | manage
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE webhooks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  url           text NOT NULL,
  secret_enc    text NOT NULL,                      -- HMAC signing secret (encrypted)
  events        text[] NOT NULL,
  include_text  boolean NOT NULL DEFAULT true,      -- false: events carry ids and metadata only, no message text
  enabled       boolean NOT NULL DEFAULT true,
  failures      integer NOT NULL DEFAULT 0,         -- consecutive failed deliveries; the webhook disables itself at 20
  disabled_reason text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL,
  event           text NOT NULL,
  payload         jsonb NOT NULL,                   -- contains customer data: purged after 7 days
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_code   integer,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries (webhook_id, created_at DESC);
