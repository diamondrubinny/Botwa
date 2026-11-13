-- The one-time code of a form signing is a message of its own kind: the website chat shows it to the visitor (it reads the
-- stored messages), the inbox always shows it masked, so staff never see a code they could sign with.
ALTER TABLE messages DROP CONSTRAINT messages_automation_check;
ALTER TABLE messages ADD CONSTRAINT messages_automation_check CHECK (automation IN ('idle_reminder', 'idle_close', 'holding', 'closing', 'feedback', 'feedback_thanks', 'customer_close', 'introduce', 'form_otp'));
