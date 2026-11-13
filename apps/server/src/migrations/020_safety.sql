-- Safety unit: standards imported from spreadsheets, board categories with keywords, many-to-many source/category.
ALTER TABLE kb_categories ADD COLUMN keywords text[] NOT NULL DEFAULT '{}';   -- words that put a source into this category
ALTER TABLE kb_categories ADD COLUMN board boolean NOT NULL DEFAULT false;    -- shown on the SafetyBoard
ALTER TABLE kb_categories ADD COLUMN sort integer NOT NULL DEFAULT 0;

ALTER TABLE kb_sources ADD COLUMN reference text;                              -- citation, e.g. "פקודה ס׳ 4" or the legal reference of an answer
ALTER TABLE kb_sources ADD COLUMN origin text;                                 -- which import produced it (re-importing updates instead of duplicating)
ALTER TABLE kb_sources ADD COLUMN external_id text;
ALTER TABLE kb_sources ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';            -- the original spreadsheet fields (answerer, date, cross references...)
CREATE UNIQUE INDEX kb_sources_origin_idx ON kb_sources (origin, external_id) WHERE origin IS NOT NULL;

CREATE TABLE kb_source_cats (
  source_id   uuid NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES kb_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, category_id)
);
CREATE INDEX kb_source_cats_cat_idx ON kb_source_cats (category_id);
