-- A customer message the bot could not answer yet (the channel was down or sending failed): kept so the bot answers once the channel is back.
ALTER TABLE conversations ADD COLUMN bot_pending_at    timestamptz;
ALTER TABLE conversations ADD COLUMN bot_pending_ext   text;       -- external id of the unanswered customer message
ALTER TABLE conversations ADD COLUMN bot_pending_text  text;
ALTER TABLE conversations ADD COLUMN bot_pending_media boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN bot_tries         smallint NOT NULL DEFAULT 0;
CREATE INDEX conversations_bot_pending_idx ON conversations (bot_pending_at) WHERE bot_pending_at IS NOT NULL;
