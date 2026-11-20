-- Officers: an office phone, whether Betty may give their details to customers, and whether their WhatsApp (often a personal
-- mobile) may be shown too (off by default).
ALTER TABLE officers ADD COLUMN IF NOT EXISTS office_phone text CHECK (office_phone IS NULL OR length(office_phone) <= 40);
ALTER TABLE officers ADD COLUMN IF NOT EXISTS public boolean NOT NULL DEFAULT true;
ALTER TABLE officers ADD COLUMN IF NOT EXISTS show_whatsapp boolean NOT NULL DEFAULT false;
