-- Site crawling options and the report of the last crawl, per crawled link.
ALTER TABLE kb_sources ADD COLUMN crawl_cfg jsonb NOT NULL DEFAULT '{}';
ALTER TABLE kb_sources ADD COLUMN crawl_report jsonb;
ALTER TABLE kb_sources DROP CONSTRAINT IF EXISTS kb_sources_crawl_pages_check;
ALTER TABLE kb_sources ADD CONSTRAINT kb_sources_crawl_pages_check CHECK (crawl_pages BETWEEN 0 AND 300);
