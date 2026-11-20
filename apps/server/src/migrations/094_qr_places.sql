-- QR stickers on lab doors: scanning one opens a chat with the place already known.
CREATE TABLE IF NOT EXISTS qr_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  building text NOT NULL DEFAULT '',
  room text NOT NULL DEFAULT '',
  label text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  -- how often it was scanned (no IP, no visitor details)
  scans integer NOT NULL DEFAULT 0,
  last_scan_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- the sticker a conversation came from, and when (used by the bot for 24 hours)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS place_id uuid REFERENCES qr_places(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS place_at timestamptz;
