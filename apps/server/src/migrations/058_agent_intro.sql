-- "שלום, כאן דנה כהן, ממונת בטיחות. אני אטפל בפנייתך": the customer is told who took the inquiry.
-- What each person shows about themselves is theirs to fill (optional): a role/title and an optional work phone.
ALTER TABLE users ADD COLUMN job_title text CHECK (job_title IS NULL OR char_length(job_title) BETWEEN 1 AND 80);
ALTER TABLE users ADD COLUMN intro_phone text CHECK (intro_phone IS NULL OR intro_phone ~ '^\+?[0-9][0-9 -]{5,18}[0-9]$');
-- who was last introduced to the customer, and in which inquiry (introduced again after a hand-over or in a new inquiry)
ALTER TABLE conversations ADD COLUMN introduced_to uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN introduced_case uuid REFERENCES cases(id) ON DELETE SET NULL;
ALTER TABLE messages DROP CONSTRAINT messages_automation_check;
ALTER TABLE messages ADD CONSTRAINT messages_automation_check CHECK (automation IN ('idle_reminder', 'idle_close', 'holding', 'closing', 'feedback', 'feedback_thanks', 'customer_close', 'introduce'));
