-- A wide emergency (an alarm, a big fire): while it is on, everyone who writes gets the unit's status message once.
ALTER TABLE messages DROP CONSTRAINT messages_automation_check;
ALTER TABLE messages ADD CONSTRAINT messages_automation_check CHECK (automation IN ('idle_reminder', 'idle_close', 'holding', 'closing', 'feedback', 'feedback_thanks', 'customer_close', 'introduce', 'form_otp', 'emergency', 'waiting_status', 'officer_info', 'comfort', 'comfort_follow', 'incident'));
