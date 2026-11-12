-- A small library of approved GIFs that agents send to customers. Files live in the database so they are part of backups.
CREATE TABLE gif_gallery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  keywords text NOT NULL DEFAULT '' CHECK (char_length(keywords) <= 300),
  gif bytea NOT NULL,
  mp4 bytea,                                     -- the same animation as a silent MP4 (null when the server has no ffmpeg)
  width int NOT NULL, height int NOT NULL,
  size int NOT NULL,
  sha256 text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gif_gallery_created ON gif_gallery (created_at DESC);
