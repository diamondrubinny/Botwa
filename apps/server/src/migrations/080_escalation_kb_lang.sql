-- Escalation: when Betty marked a conversation urgent (an emergency or a hazard report), and whether it was escalated since.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS urgent_since timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
CREATE INDEX IF NOT EXISTS conversations_urgent_idx ON conversations (urgent_since) WHERE urgent_since IS NOT NULL AND escalated_at IS NULL;

-- Knowledge base entries in English: the language of an entry (from its title and text); search prefers the conversation's language.
ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS lang text CHECK (lang IS NULL OR lang IN ('he', 'en'));
UPDATE kb_sources SET lang = CASE
    WHEN coalesce(title, '') || ' ' || coalesce(body, '') ~ '[א-ת]' THEN 'he'
    WHEN coalesce(title, '') || ' ' || coalesce(body, '') ~ '[A-Za-z]{3,}' THEN 'en'
    ELSE NULL END
 WHERE lang IS NULL;
