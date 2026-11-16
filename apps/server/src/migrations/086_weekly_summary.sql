-- A weekly safety summary on WhatsApp (Sunday morning) for managers who linked WhatsApp to Betty; each can switch it off.
ALTER TABLE users ADD COLUMN weekly_summary boolean NOT NULL DEFAULT true;
