-- Messages staff schedule into an existing conversation. Sending still obeys the block / opt-out / reply-window / rate-cap rules at the moment it is due.
CREATE TABLE scheduled_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  send_at         timestamptz NOT NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  error           text,
  attempts        int NOT NULL DEFAULT 0,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_due_idx ON scheduled_messages (send_at) WHERE status = 'pending';
CREATE INDEX scheduled_conv_idx ON scheduled_messages (conversation_id, send_at);
