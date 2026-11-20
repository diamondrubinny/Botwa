-- Managers ask Betty on WhatsApp about the inquiries. A WhatsApp account is linked to a user only by a one-time code made in the
-- panel (signed in) and sent from that WhatsApp account: proof of both. The link can be removed at any time.
CREATE TABLE staff_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (channel_id, external_id)
);
CREATE INDEX staff_links_user ON staff_links (user_id);
CREATE TABLE staff_link_codes (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,   -- one open code per user
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL
);
