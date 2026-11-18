-- Machine translation for the team, by the local model on this server (no outside service).
-- A customer's message translated into Hebrew for the agent: kept with the message and deleted with it (retention, erasure).
CREATE TABLE IF NOT EXISTS message_translations (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  lang text NOT NULL CHECK (lang IN ('he', 'en', 'ar', 'ru')),
  body text NOT NULL,
  model text,
  -- the numbers in the translation differ from the original's: the agent is told to check them
  numbers_differ boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, lang)
);
-- An agent's reply that was sent translated: the Hebrew the agent wrote (the message body is what the customer got).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS translated_from text;
