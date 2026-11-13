-- Knowledge base: documents, links and FAQ entries that the bot (and agents) can answer from. Search is PostgreSQL full text (no AI, nothing leaves the server).
CREATE TABLE kb_categories (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60)
);

CREATE TABLE kb_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('faq', 'text', 'file', 'link')),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  variants        text[] NOT NULL DEFAULT '{}',        -- faq: other ways customers ask the same question
  body            text,                                 -- faq/text: the content as written by staff
  url             text,
  file_name       text,
  mime            text,
  size            integer,
  category_id     uuid REFERENCES kb_categories(id) ON DELETE SET NULL,
  audience        text NOT NULL DEFAULT 'both' CHECK (audience IN ('bot', 'staff', 'both')),
  boost           smallint NOT NULL DEFAULT 0 CHECK (boost BETWEEN 0 AND 2),
  enabled         boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'error')),
  error           text,
  content_hash    text,
  crawl_pages     smallint NOT NULL DEFAULT 0 CHECK (crawl_pages BETWEEN 0 AND 25),  -- link: also read up to N same-site pages linked from it
  refresh_hours   integer CHECK (refresh_hours IS NULL OR refresh_hours BETWEEN 1 AND 8760),
  last_fetched_at timestamptz,
  parent_id       uuid REFERENCES kb_sources(id) ON DELETE CASCADE,   -- pages found by crawling a link
  version         integer NOT NULL DEFAULT 1,
  uses            integer NOT NULL DEFAULT 0,
  helpful         integer NOT NULL DEFAULT 0,
  unhelpful       integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX kb_sources_link_url_idx ON kb_sources (url) WHERE kind = 'link';
CREATE INDEX kb_sources_parent_idx ON kb_sources (parent_id);

CREATE TABLE kb_chunks (
  id        bigserial PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  ord       integer NOT NULL,
  heading   text,
  body      text NOT NULL,
  terms     text NOT NULL,        -- normalised words (+ prefix-stripped variants) used for matching
  tsv       tsvector NOT NULL
);
CREATE INDEX kb_chunks_tsv_idx ON kb_chunks USING gin (tsv);
CREATE INDEX kb_chunks_source_idx ON kb_chunks (source_id, ord);

-- groups of equivalent words ("משלוח, שילוח, delivery")
CREATE TABLE kb_synonyms (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  words text[] NOT NULL CHECK (cardinality(words) BETWEEN 2 AND 20)
);

-- what was asked and whether the base could answer (kept short; purged by retention). Customer text can be personal data.
CREATE TABLE kb_queries (
  id         bigserial PRIMARY KEY,
  text       text NOT NULL,
  via        text NOT NULL CHECK (via IN ('bot', 'staff', 'test')),
  answered   boolean NOT NULL,
  score      real,
  source_id  uuid REFERENCES kb_sources(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kb_queries_created_idx ON kb_queries (created_at);

CREATE TABLE kb_feedback (
  id         bigserial PRIMARY KEY,
  source_id  uuid NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  helpful    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
