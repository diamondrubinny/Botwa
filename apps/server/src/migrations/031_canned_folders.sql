-- Canned replies: folders, and an updated-at so edits are visible.
ALTER TABLE canned_replies ADD COLUMN folder text NOT NULL DEFAULT '' CHECK (length(folder) <= 40);
ALTER TABLE canned_replies ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
