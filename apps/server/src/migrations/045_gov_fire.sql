-- Stage 4 of the public-sources import: fire-safety requirements for business licensing (Fire and Rescue Authority, data.gov.il).
ALTER TABLE gov_sources DROP CONSTRAINT IF EXISTS gov_sources_key_check;
ALTER TABLE gov_sources ADD CONSTRAINT gov_sources_key_check CHECK (key IN ('wikisource', 'standards', 'fire'));
ALTER TABLE gov_sources ADD COLUMN catalog_json jsonb;   -- business types found at the source: [{code, name, group, subtypes, requirements}]
INSERT INTO gov_sources (key) VALUES ('fire');
