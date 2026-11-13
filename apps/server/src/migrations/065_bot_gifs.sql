-- The bot (Betty) may add a fitting GIF from the gallery at pleasant moments; at most one per conversation within the cool-down.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_bot_gif_at timestamptz;
