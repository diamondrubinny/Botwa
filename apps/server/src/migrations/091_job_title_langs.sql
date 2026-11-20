-- The person's role in English and in Arabic, for the "this is …, <role>" message in conversations in those languages.
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title_en text CHECK (job_title_en IS NULL OR char_length(job_title_en) BETWEEN 1 AND 80);
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title_ar text CHECK (job_title_ar IS NULL OR char_length(job_title_ar) BETWEEN 1 AND 80);
