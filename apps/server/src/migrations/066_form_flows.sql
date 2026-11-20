-- Forms filled inside WhatsApp (WhatsApp Flows, official channel): per template a switch, short labels (Meta: 20 characters),
-- and the published Flow per channel; per request how it was sent and the Flow's field names as they were.
ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS flow_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS flow_labels jsonb NOT NULL DEFAULT '{}';
ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS flows jsonb NOT NULL DEFAULT '{}';   -- { "<channel id>": { flowId, status, version, names, errors, previewUrl, at } }
ALTER TABLE form_requests ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'link' CHECK (via IN ('link', 'flow'));
ALTER TABLE form_requests ADD COLUMN IF NOT EXISTS flow_names jsonb;
