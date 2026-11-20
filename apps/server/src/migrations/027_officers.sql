-- Officers (safety officers and engineers) by topic: who they are and how to reach them, optionally linked to a system account.
CREATE TABLE officers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email      text CHECK (email IS NULL OR length(email) <= 254),
  phone      text CHECK (phone IS NULL OR phone ~ '^[0-9]{8,15}$'),   -- WhatsApp number, digits with country code
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,            -- the officer's account: conversations are assigned to it
  notes      text NOT NULL DEFAULT '' CHECK (length(notes) <= 300),
  active     boolean NOT NULL DEFAULT true,
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE officer_topics (
  officer_id uuid NOT NULL REFERENCES officers(id) ON DELETE CASCADE,
  topic      text NOT NULL CHECK (length(topic) BETWEEN 1 AND 60),
  PRIMARY KEY (officer_id, topic)
);
CREATE INDEX officer_topics_topic_idx ON officer_topics (lower(topic));
