-- One person across channels. Contacts that staff linked share a person_id (a plain group id; no separate table).
-- claimed_phone / claimed_email: what the customer typed (e.g. in the website chat form). Not verified: used only to SUGGEST a link.
ALTER TABLE contacts ADD COLUMN person_id uuid;
ALTER TABLE contacts ADD COLUMN claimed_phone text CHECK (claimed_phone ~ '^\d{6,15}$');
ALTER TABLE contacts ADD COLUMN claimed_email text CHECK (char_length(claimed_email) <= 254);
CREATE INDEX contacts_person_idx ON contacts (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX contacts_claimed_phone_idx ON contacts (claimed_phone) WHERE claimed_phone IS NOT NULL;
CREATE INDEX contacts_claimed_email_idx ON contacts (lower(claimed_email)) WHERE claimed_email IS NOT NULL;
-- the phone number a WhatsApp contact id carries (verified by WhatsApp itself), for matching
CREATE INDEX contacts_wa_phone_idx ON contacts ((split_part(external_id, '@', 1))) WHERE external_id LIKE '%@s.whatsapp.net';
