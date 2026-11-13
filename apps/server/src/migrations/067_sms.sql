-- SMS (outbound only): the one-time code for forms when it does not reach the chat, and reminders to people WhatsApp cannot reach.
-- Settings live in settings('sms'); the provider's secret is encrypted in settings('sms_secret'). Each send is logged for the
-- monthly cap and the audit; the log keeps the number masked and is purged after 180 days.
CREATE TABLE IF NOT EXISTS sms_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  to_masked   text NOT NULL,                       -- "+97250•••4567"
  purpose     text NOT NULL CHECK (purpose IN ('otp', 'reminder', 'test')),
  request_id  uuid REFERENCES form_requests(id) ON DELETE SET NULL,
  segments    int NOT NULL DEFAULT 1,
  provider_id text,                                -- the provider's message id
  status      text NOT NULL,                       -- queued / sent / failed
  error       text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_log_created ON sms_log (created_at DESC);
