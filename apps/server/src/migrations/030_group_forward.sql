-- Forwarding conversations to a WhatsApp group (a linked WhatsApp number that is a member of the group).
CREATE TABLE forward_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  enabled          boolean NOT NULL DEFAULT true,
  channel_id       uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  group_jid        text NOT NULL CHECK (group_jid ~ '^[0-9]{5,25}(-[0-9]+)?@g\.us$'),
  group_name       text NOT NULL DEFAULT '' CHECK (length(group_name) <= 120),
  on_handoff       boolean NOT NULL DEFAULT false,                 -- forward automatically when the bot hands a conversation to people
  tag_ids          uuid[] NOT NULL DEFAULT '{}',                   -- only conversations with one of these tags (empty = all)
  include_messages smallint NOT NULL DEFAULT 3 CHECK (include_messages BETWEEN 0 AND 10),
  include_phone    boolean NOT NULL DEFAULT false,                 -- the customer's number is personal data: off unless asked for
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE forward_log (
  id              bigserial PRIMARY KEY,
  rule_id         uuid REFERENCES forward_rules(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  group_jid       text NOT NULL,
  text            text NOT NULL,
  trigger         text NOT NULL CHECK (trigger IN ('handoff', 'manual', 'test')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  tries           smallint NOT NULL DEFAULT 0,
  by_user         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX forward_log_pending_idx ON forward_log (id) WHERE status = 'pending';
CREATE UNIQUE INDEX forward_log_once_idx ON forward_log (rule_id, conversation_id) WHERE trigger = 'handoff';   -- one automatic forward per rule and conversation
