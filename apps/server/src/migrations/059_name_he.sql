-- A Hebrew display name: what customers see ("כאן דנה כהן") and what the inbox shows as the handler.
-- Optional; without it the account name is used as before.
ALTER TABLE users ADD COLUMN name_he text CHECK (name_he IS NULL OR (char_length(name_he) BETWEEN 2 AND 100 AND name_he ~ '[א-ת]'));
