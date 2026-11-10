-- Stage 2 of the public-sources import: the official standards list of the Ministry of Economy (data.gov.il).
ALTER TABLE gov_sources DROP CONSTRAINT IF EXISTS gov_sources_key_check;
ALTER TABLE gov_sources ADD CONSTRAINT gov_sources_key_check CHECK (key IN ('wikisource', 'standards'));
ALTER TABLE gov_sources ADD COLUMN keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(keywords) <= 200);   -- empty = the default safety words
ALTER TABLE gov_sources ADD COLUMN include_all boolean NOT NULL DEFAULT false;                                    -- every official standard, not only matching ones
ALTER TABLE gov_sources ADD COLUMN source_modified text;                                                          -- the dataset's own "last modified", to skip unchanged downloads
INSERT INTO gov_sources (key) VALUES ('standards');
