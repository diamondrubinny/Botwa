-- Numbered-menu topics can ask where the problem is and route to the officer responsible for that place.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_bot_state_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_bot_state_check CHECK (bot_state IN ('menu', 'human', 'area'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_item smallint;
