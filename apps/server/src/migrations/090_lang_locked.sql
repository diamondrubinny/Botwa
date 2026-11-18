-- A person can set a conversation's language by hand (the automatic detection got it wrong): kept until set back to automatic.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lang_locked boolean NOT NULL DEFAULT false;
