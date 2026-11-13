-- Automatic messages sent by the conversation automations: which one (so the timers can tell them from staff and bot replies).
ALTER TABLE messages ADD COLUMN automation text CHECK (automation IN ('idle_reminder', 'idle_close', 'holding', 'closing'));
CREATE INDEX messages_automation_idx ON messages (conversation_id, automation, created_at) WHERE automation IS NOT NULL;
