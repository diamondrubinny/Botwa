-- Laws and regulations imported automatically from public sources (stage 1: the Open Law Book on Wikisource).
CREATE TABLE gov_sources (
  key          text PRIMARY KEY CHECK (key IN ('wikisource')),
  enabled      boolean NOT NULL DEFAULT false,
  audience     text NOT NULL DEFAULT 'staff' CHECK (audience IN ('bot', 'staff', 'both')),
  refresh_days integer NOT NULL DEFAULT 7 CHECK (refresh_days BETWEEN 1 AND 90),
  selection    text[] NOT NULL DEFAULT '{}' CHECK (cardinality(selection) <= 150),   -- page titles; empty = the default list
  catalog      text[],                                                                 -- titles found at the source (for choosing)
  catalog_at   timestamptz,
  last_run_at  timestamptz,
  last_report  jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gov_sources (key) VALUES ('wikisource');

-- an imported text that staff edited is no longer overwritten by later imports
ALTER TABLE kb_sources ADD COLUMN detached boolean NOT NULL DEFAULT false;
