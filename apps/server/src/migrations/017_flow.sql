-- Bot flow chart: per-conversation position and collected answers.
ALTER TABLE conversations ADD COLUMN flow_state jsonb;
