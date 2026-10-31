-- Customer blocking (abuse / spam). Blocked contacts' messages are kept as evidence but trigger nothing.
ALTER TABLE contacts ADD COLUMN blocked boolean NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN blocked_at timestamptz;
ALTER TABLE contacts ADD COLUMN blocked_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN blocked_reason text;
CREATE INDEX contacts_blocked_idx ON contacts(blocked) WHERE blocked;

-- Channel health timeline (connected / logged out / restricted-or-banned suspicion ...)
CREATE TABLE channel_events (
  id         bigserial PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_events_idx ON channel_events(channel_id, id DESC);

-- supports the 24h / 1min outbound counters
CREATE INDEX messages_out_idx ON messages(created_at) WHERE direction = 'out';
