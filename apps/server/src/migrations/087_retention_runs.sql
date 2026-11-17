-- One row per run of the retention clean-up: when, and how many records of each kind were deleted (counts only, no content).
CREATE TABLE retention_runs (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at   timestamptz NOT NULL DEFAULT now(),
  manual   boolean NOT NULL DEFAULT false,
  counts   jsonb NOT NULL,
  error    text
);
CREATE INDEX retention_runs_at ON retention_runs (ran_at DESC);
