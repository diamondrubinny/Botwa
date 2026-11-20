ALTER TABLE users ADD COLUMN available boolean NOT NULL DEFAULT true;     -- agent can toggle "on duty"
ALTER TABLE users ADD COLUMN last_assigned_at timestamptz;                -- round-robin fairness
