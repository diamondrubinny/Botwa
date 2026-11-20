-- Sending one form to a group (employees, contractors): each person gets a personal request; delivery follows the platform's
-- rules (a message within the reply window, an approved template on official WhatsApp, or the link for the staff to pass on).
CREATE TABLE form_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES form_templates(id) ON DELETE RESTRICT,
  channel_id  uuid REFERENCES channels(id) ON DELETE SET NULL,
  title       text NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
  total       int NOT NULL DEFAULT 0,
  wa_template jsonb,                                  -- {name, language} when an approved template carries the link
  done        boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE form_requests ADD CONSTRAINT form_requests_batch_fk FOREIGN KEY (batch_id) REFERENCES form_batches(id) ON DELETE SET NULL;
ALTER TABLE form_requests
  ADD COLUMN delivery text CHECK (delivery IN ('queued', 'sent', 'template', 'link_only', 'failed')),
  ADD COLUMN delivery_detail text,
  ADD COLUMN link_enc text,                           -- the personal link, encrypted, for group requests (to pass on or remind)
  ADD COLUMN reminded_at timestamptz;
CREATE INDEX form_requests_batch ON form_requests (batch_id) WHERE batch_id IS NOT NULL;
