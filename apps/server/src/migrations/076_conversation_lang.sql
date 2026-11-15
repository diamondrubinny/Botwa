-- The language the customer writes in (Hebrew or English): Betty answers in it. NULL: not known yet (Hebrew).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lang text CHECK (lang IS NULL OR lang IN ('he', 'en'));
