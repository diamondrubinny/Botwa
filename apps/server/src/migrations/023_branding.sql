-- Branding: one logo for the whole installation (raster image, validated and scanned before it is stored).
CREATE TABLE branding_logo (
  id smallint PRIMARY KEY CHECK (id = 1),
  mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  data bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
