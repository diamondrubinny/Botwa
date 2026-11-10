-- Antivirus: stored files are scanned again with fresh signatures; this records when each one was last checked.
ALTER TABLE attachments ADD COLUMN last_scanned_at timestamptz;
UPDATE attachments SET last_scanned_at = created_at WHERE status = 'clean';
CREATE INDEX attachments_rescan_idx ON attachments (last_scanned_at NULLS FIRST) WHERE status = 'clean' AND storage_name IS NOT NULL;
