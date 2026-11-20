-- Responsibility areas: which safety officer answers for which building or place (matched against what the customer wrote).
CREATE TABLE responsibility_areas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  keywords   text[] NOT NULL DEFAULT '{}',       -- building names or numbers, rooms, places
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- What the identification step learned about a customer (name, faculty, status...), so the next conversation does not ask again.
ALTER TABLE contacts ADD COLUMN profile jsonb NOT NULL DEFAULT '{}';
