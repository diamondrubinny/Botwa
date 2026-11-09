-- Which phone/desktop alerts each person wants: new customer messages, a conversation assigned or handed to them, SLA breaches.
ALTER TABLE users ADD COLUMN push_prefs jsonb NOT NULL DEFAULT '{"messages": true, "assigned": true, "sla": true}';
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
