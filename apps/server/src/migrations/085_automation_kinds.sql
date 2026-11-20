-- New kinds of automatic messages: Betty's answers while the team has not written yet ('waiting_answer'), and the note to the
-- reporter that a hazard was handled ('hazard_done'). Without them in the list such a message was sent but not stored.
ALTER TABLE messages DROP CONSTRAINT messages_automation_check;
ALTER TABLE messages ADD CONSTRAINT messages_automation_check CHECK (automation IN ('idle_reminder', 'idle_close', 'holding', 'closing', 'feedback', 'feedback_thanks', 'customer_close', 'introduce', 'form_otp', 'emergency', 'waiting_status', 'officer_info', 'comfort', 'comfort_follow', 'incident', 'waiting_answer', 'hazard_done'));
