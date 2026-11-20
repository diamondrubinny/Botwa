-- Betty stays with a stressed customer until a person answers: when the comforting message was sent and how many follow-ups went out.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS comfort_since timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS comfort_steps smallint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS conversations_comfort_idx ON conversations (comfort_since) WHERE comfort_since IS NOT NULL;
ALTER TABLE messages DROP CONSTRAINT messages_automation_check;
ALTER TABLE messages ADD CONSTRAINT messages_automation_check CHECK (automation IN ('idle_reminder', 'idle_close', 'holding', 'closing', 'feedback', 'feedback_thanks', 'customer_close', 'introduce', 'form_otp', 'emergency', 'waiting_status', 'officer_info', 'comfort', 'comfort_follow'));
