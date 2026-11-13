-- Profile pictures: one small image per person (location and camera details are removed before it is stored).
CREATE TABLE user_avatars (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime       text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  data       bytea NOT NULL CHECK (octet_length(data) <= 524288),
  updated_at timestamptz NOT NULL DEFAULT now()
);
