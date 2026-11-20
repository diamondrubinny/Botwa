-- The bot's identity shown to customers and staff: a name and role (settings key 'bot_persona') and a picture.
CREATE TABLE bot_avatar (
  id         int PRIMARY KEY CHECK (id = 1),
  mime       text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  data       bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
