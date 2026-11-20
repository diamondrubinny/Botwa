-- WhatsApp usernames (Meta, 2026): a customer who hides their phone number arrives with a business-scoped user id (BSUID) only.
-- The id is kept on the contact so the same person stays one contact whether a message carries the number, the id or both.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS user_id text;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_channel_user_id ON contacts (channel_id, user_id) WHERE user_id IS NOT NULL;

-- The business username of an official number as last read from Meta or reported by its webhook (Meta is the source of truth).
CREATE TABLE IF NOT EXISTS wa_business_usernames (
  channel_id  uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  username    text,
  status      text NOT NULL,          -- approved | reserved | deleted | none
  context     text,                   -- e.g. "revoked" (from the webhook)
  updated_at  timestamptz NOT NULL DEFAULT now()
);
