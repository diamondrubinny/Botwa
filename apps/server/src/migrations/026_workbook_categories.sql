-- Categories that come from the workbook itself (its category column or its tab names), kept apart from keyword matching.
ALTER TABLE kb_source_cats ADD COLUMN via text NOT NULL DEFAULT 'keywords';   -- 'keywords' (recomputed) or 'workbook' (stated by the file)
ALTER TABLE kb_categories ADD COLUMN origin text NOT NULL DEFAULT 'spec';     -- 'spec' (the unit's list) or 'workbook'
