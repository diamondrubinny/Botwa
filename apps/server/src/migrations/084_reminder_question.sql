-- The idle reminder asked two things at once ("did you get our answer? anything else?"), so a plain "לא" could mean either.
-- The untouched default becomes one question with a yes/no answer, which Betty now reads ("לא" goes back to the team).
UPDATE settings SET value = jsonb_set(value, '{idle,reminderText}', to_jsonb('היי {שם}, רצינו לוודא: קיבלת מענה לפנייה? אפשר לענות "כן" או "לא".'::text)), updated_at = now()
 WHERE key = 'automations' AND value->'idle'->>'reminderText' = 'היי {שם}, רצינו לוודא שקיבלת את התשובה שלנו. יש עוד משהו שנוכל לעזור בו?';
