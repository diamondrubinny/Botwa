-- Embedding vectors for "meaning" search (local model). Optional: empty when SEMANTIC_SEARCH=off.
CREATE TABLE kb_vectors (
  id        bigserial PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  chunk_id  bigint REFERENCES kb_chunks(id) ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN ('q', 'p')),    -- q: a question phrase (title / variant), p: a passage
  model     text NOT NULL,
  vec       bytea NOT NULL
);
CREATE INDEX kb_vectors_source_idx ON kb_vectors (source_id);
ALTER TABLE kb_sources ADD COLUMN embedded_model text;   -- model whose vectors are stored for this source (NULL = not embedded yet)
