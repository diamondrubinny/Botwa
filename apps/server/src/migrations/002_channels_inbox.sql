CREATE TABLE channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL CHECK (type IN ('whatsapp', 'telegram')),
  label       text NOT NULL,
  status      text NOT NULL DEFAULT 'stopped',
  auto_start  boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Encrypted (AES-256-GCM) platform session material: WhatsApp creds/keys, Telegram session string.
CREATE TABLE channel_auth (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value_enc  text NOT NULL,
  PRIMARY KEY (channel_id, key)
);

CREATE TABLE contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id   uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id  text NOT NULL,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_id)
);

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  assigned_to     uuid REFERENCES users(id) ON DELETE SET NULL,
  unread_count    int NOT NULL DEFAULT 0,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_last_idx ON conversations(last_message_at DESC);
CREATE INDEX conversations_assigned_idx ON conversations(assigned_to);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  body            text NOT NULL,
  external_id     text,
  sender_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages(conversation_id, created_at DESC);
CREATE UNIQUE INDEX messages_dedupe_idx ON messages(conversation_id, external_id) WHERE external_id IS NOT NULL;
