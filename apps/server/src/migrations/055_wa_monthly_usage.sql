-- Official WhatsApp: outgoing messages per business phone number per calendar month (UTC), against a limit set per channel.
-- Keyed by the phone number id, so a channel that is deleted and created again for the same number keeps its count.
CREATE TABLE wa_monthly_usage (
  number_key  text NOT NULL,
  month       date NOT NULL,                 -- the first day of the month (UTC)
  channel_id  uuid REFERENCES channels(id) ON DELETE SET NULL,
  text        integer NOT NULL DEFAULT 0,
  media       integer NOT NULL DEFAULT 0,
  template    integer NOT NULL DEFAULT 0,
  interactive integer NOT NULL DEFAULT 0,
  reaction    integer NOT NULL DEFAULT 0,
  seeded      integer NOT NULL DEFAULT 0,    -- sent this month before counting started (from the stored messages)
  blocked     integer NOT NULL DEFAULT 0,    -- refused because the limit was reached
  warned      boolean NOT NULL DEFAULT false,
  reached     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (number_key, month)
);
-- { limit, action: warn | block_auto | block_all, warnAt (percent) }; NULL = the defaults
ALTER TABLE channels ADD COLUMN usage_limit jsonb;
