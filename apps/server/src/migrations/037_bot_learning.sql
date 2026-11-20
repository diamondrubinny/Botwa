-- The bot learns with a person's approval: suggestions gathered from real conversations, applied only when approved.
CREATE TABLE kb_learn (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('variant', 'faq_draft', 'option_example')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  source_id     uuid REFERENCES kb_sources(id) ON DELETE CASCADE,     -- variant: the entry the wording belongs to
  target        text NOT NULL DEFAULT '',                              -- variant: source id; option_example: "<node>\n<option label>"
  text          text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),  -- the customer's wording (faq_draft: the question)
  answer        text CHECK (answer IS NULL OR length(answer) <= 4000), -- faq_draft: the staff answer, personal details removed
  norm          text NOT NULL,
  hits          int NOT NULL DEFAULT 1,                                -- different conversations that produced it
  conversations uuid[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz
);
CREATE UNIQUE INDEX kb_learn_key ON kb_learn (kind, target, norm);
CREATE INDEX kb_learn_pending ON kb_learn (kind, hits DESC) WHERE status = 'pending';

-- which knowledge-base entry a bot message answered from, so a customer's reaction on it counts as feedback
ALTER TABLE messages ADD COLUMN kb_source_id uuid REFERENCES kb_sources(id) ON DELETE SET NULL;
CREATE TABLE kb_answer_reactions (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  source_id  uuid NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  positive   boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kb_answer_reactions_source ON kb_answer_reactions (source_id, created_at);
ALTER TABLE kb_sources ADD COLUMN feedback_reviewed_at timestamptz;
