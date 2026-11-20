-- Russian for customer conversations: a conversation and a knowledge-base entry may be in Russian; the person's role in Russian.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_lang_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_lang_check CHECK (lang IS NULL OR lang IN ('he', 'en', 'ar', 'ru'));
ALTER TABLE kb_sources DROP CONSTRAINT IF EXISTS kb_sources_lang_check;
ALTER TABLE kb_sources ADD CONSTRAINT kb_sources_lang_check CHECK (lang IS NULL OR lang IN ('he', 'en', 'ar', 'ru'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title_ru text CHECK (job_title_ru IS NULL OR char_length(job_title_ru) BETWEEN 1 AND 80);
