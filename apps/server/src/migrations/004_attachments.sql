CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  mime          text,
  size          bigint,
  sha256        text,
  file_name     text,
  storage_name  uuid,          -- NULL when the file was never stored (blocked)
  status        text NOT NULL CHECK (status IN ('pending', 'clean', 'infected', 'blocked')),
  detail        text,
  scan_attempts int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_pending_idx ON attachments(created_at) WHERE status = 'pending';
