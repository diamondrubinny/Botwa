-- Pictures admins add to the avatar gallery (next to the built-in ones), for people who prefer to pick rather than upload a photo.
CREATE TABLE avatar_gallery (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL DEFAULT '' CHECK (length(name) <= 60),
  mime       text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  data       bytea NOT NULL CHECK (octet_length(data) <= 524288),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
