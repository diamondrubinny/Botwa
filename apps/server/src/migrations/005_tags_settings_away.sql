CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tags_name_idx ON tags (lower(name));

CREATE TABLE conversation_tags (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id          uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);
CREATE INDEX conversation_tags_tag_idx ON conversation_tags(tag_id);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- automatic replies (e.g. out-of-hours) are marked so reports do not count them as a human response
ALTER TABLE messages ADD COLUMN auto boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN last_away_at timestamptz;
