-- When the "customer is waiting past the SLA target" alert last fired for a conversation (once per waiting customer message).
ALTER TABLE conversations ADD COLUMN sla_alerted_at timestamptz;
