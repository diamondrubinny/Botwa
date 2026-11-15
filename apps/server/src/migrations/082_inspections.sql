-- Periodic safety inspections ("בדיקת מטפים בבניין X כל חצי שנה"): what, where, how often, who is responsible, when it is due next,
-- and a log of each time it was done. Reminders go to the person responsible a week before and while it is overdue.
CREATE TABLE inspections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  place            text NOT NULL DEFAULT '' CHECK (char_length(place) <= 120),
  interval_days    int NOT NULL CHECK (interval_days BETWEEN 1 AND 3650),
  next_due         date NOT NULL,
  assignee         uuid REFERENCES users(id) ON DELETE SET NULL,
  notes            text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  active           boolean NOT NULL DEFAULT true,
  last_done_at     timestamptz,
  last_reminded_at timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inspections_due_idx ON inspections (next_due) WHERE active;
CREATE TABLE inspection_log (
  id            bigserial PRIMARY KEY,
  inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  done_at       timestamptz NOT NULL DEFAULT now(),
  done_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000)
);
CREATE INDEX inspection_log_idx ON inspection_log (inspection_id, done_at DESC);
