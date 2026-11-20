-- The emoji we put on a customer's message: chosen by a staff member, or the automatic "thanks" reaction (by = NULL).
-- Shown in the inbox and in the website chat; sent to the platform where it supports reactions.
ALTER TABLE messages
  ADD COLUMN our_reaction text CHECK (our_reaction IS NULL OR char_length(our_reaction) BETWEEN 1 AND 16),
  ADD COLUMN our_reaction_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN our_reaction_at timestamptz;
