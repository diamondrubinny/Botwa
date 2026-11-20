-- The answer to "מתי חוזרים אליי?" while an inquiry is with the team is an automatic message of its own kind (at most every 30 minutes).
ALTER TABLE messages DROP CONSTRAINT messages_automation_check;
ALTER TABLE messages ADD CONSTRAINT messages_automation_check CHECK (automation IN ('idle_reminder', 'idle_close', 'holding', 'closing', 'feedback', 'feedback_thanks', 'customer_close', 'introduce', 'form_otp', 'emergency', 'waiting_status'));
