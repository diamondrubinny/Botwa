-- How a staff reply to a public comment went out: 'public' (under the comment, seen by everyone) or 'private' (a direct message).
ALTER TABLE messages ADD COLUMN reply_mode text CHECK (reply_mode IN ('public', 'private'));
