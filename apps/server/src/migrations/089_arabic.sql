-- Arabic for customer conversations: a conversation may be in Arabic, and a knowledge-base entry may be written in Arabic.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_lang_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_lang_check CHECK (lang IS NULL OR lang IN ('he', 'en', 'ar'));
ALTER TABLE kb_sources DROP CONSTRAINT IF EXISTS kb_sources_lang_check;
ALTER TABLE kb_sources ADD CONSTRAINT kb_sources_lang_check CHECK (lang IS NULL OR lang IN ('he', 'en', 'ar'));
