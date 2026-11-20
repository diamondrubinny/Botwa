-- A customer can close their own inquiry by writing so ("הסתדרתי", "תסגרו את הקריאה").
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_close_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_close_kind_check CHECK (close_kind IN ('staff', 'auto', 'customer', 'other'));
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_close_kind_check;
ALTER TABLE cases ADD CONSTRAINT cases_close_kind_check CHECK (close_kind IN ('staff', 'auto', 'customer', 'other'));
ALTER TABLE messages DROP CONSTRAINT messages_automation_check;
ALTER TABLE messages ADD CONSTRAINT messages_automation_check CHECK (automation IN ('idle_reminder', 'idle_close', 'holding', 'closing', 'feedback', 'feedback_thanks', 'customer_close'));
