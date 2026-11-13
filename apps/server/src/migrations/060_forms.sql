-- Digital forms: a PDF template with fields placed on its pages, sent to a person by a link in WhatsApp (or any channel),
-- filled and signed on the phone after a one-time code to the same chat, kept as a locked PDF with a signature record page.
CREATE TABLE form_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  audience    text[] NOT NULL DEFAULT '{}',            -- employee, contractor, student, guest, customer (for filtering)
  source_pdf  bytea NOT NULL,
  source_name text NOT NULL DEFAULT '',
  source_url  text,                                    -- where it was imported from, if it was
  sha256      text NOT NULL,
  pages       jsonb NOT NULL,                          -- [{w,h}] in PDF points
  fields      jsonb NOT NULL DEFAULT '[]',             -- see forms/schema.ts
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE form_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  template_id     uuid NOT NULL REFERENCES form_templates(id) ON DELETE RESTRICT,
  template_sha256 text NOT NULL,                       -- the exact version that was sent
  fields          jsonb NOT NULL,                      -- the fields as they were when sent (later edits do not change it)
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  signer_name     text,
  signer_phone    text,
  token_hash      text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'opened', 'verified', 'signed', 'expired', 'cancelled')),
  prefill         jsonb NOT NULL DEFAULT '{}',
  expires_at      timestamptz NOT NULL,
  otp_hash        text,
  otp_expires_at  timestamptz,
  otp_tries       int NOT NULL DEFAULT 0,
  otp_sent        int NOT NULL DEFAULT 0,
  fill_key_hash   text,                                -- given after the code is verified; needed to submit
  verified_at     timestamptz,
  sent_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  signed_at       timestamptz,
  batch_id        uuid
);
CREATE INDEX form_requests_conv ON form_requests (conversation_id, created_at DESC);
CREATE INDEX form_requests_template ON form_requests (template_id, created_at DESC);

CREATE TABLE form_submissions (
  request_id   uuid PRIMARY KEY REFERENCES form_requests(id) ON DELETE CASCADE,
  values_enc   text NOT NULL,                          -- the values, encrypted (ENCRYPTION_KEY)
  signed_pdf   bytea NOT NULL,                         -- encrypted PDF bytes (AES-GCM, see crypto.ts)
  sha256       text NOT NULL UNIQUE,                   -- of the final PDF as delivered: anyone can check a copy against it
  signer_ip    text,
  signer_ua    text,
  signed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE form_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  uuid NOT NULL REFERENCES form_requests(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  detail      text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_events_req ON form_events (request_id, id);
