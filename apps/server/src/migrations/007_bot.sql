-- Menu bot state per conversation: NULL = bot has not greeted yet, 'menu' = bot is handling, 'human' = handed to staff (bot silent)
ALTER TABLE conversations ADD COLUMN bot_state text CHECK (bot_state IN ('menu', 'human'));
ALTER TABLE conversations ADD COLUMN bot_invalid int NOT NULL DEFAULT 0;
