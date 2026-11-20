-- Snooze: a conversation is hidden from the default open list until snoozed_until (a new customer message wakes it early).
ALTER TABLE conversations ADD COLUMN snoozed_until timestamptz;
CREATE INDEX conversations_snoozed_idx ON conversations (snoozed_until) WHERE snoozed_until IS NOT NULL;

-- Personal stars: private to each staff member.
CREATE TABLE conversation_stars (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conversation_id)
);
