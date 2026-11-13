-- The bot introduces itself by its persona name and greets customers it already knows by first name ({בוט}, {שם פרטי}: bot-text.ts).
-- 1) Flows built from the safety-unit template: a "welcome back" message for known customers, a thank-you after the identification,
--    and the opening line names the bot. Only template flows that never had these nodes are touched; a changed opening line stays.
UPDATE settings s SET value = jsonb_set(s.value, '{nodes}',
    (SELECT jsonb_agg(
        CASE
          WHEN n->>'id' = 'start' AND n->>'type' = 'condition' AND n->>'yes' = 'topics' THEN jsonb_set(n, '{yes}', '"welcome_back"')
          WHEN n->>'id' = 'remember' AND n->>'type' = 'remember' AND n->>'next' = 'topics' THEN jsonb_set(n, '{next}', '"id_saved"')
          WHEN n->>'id' = 'id_intro' AND n->>'type' = 'message' AND starts_with(n->>'text', 'שלום, כאן הבוט של יחידת הבטיחות.')
            THEN jsonb_set(n, '{text}', to_jsonb('שלום, כאן {בוט} מיחידת הבטיחות 👋' || substr(n->>'text', length('שלום, כאן הבוט של יחידת הבטיחות.') + 1)))
          ELSE n
        END ORDER BY ord)
       FROM jsonb_array_elements(s.value->'nodes') WITH ORDINALITY AS t(n, ord))
    || jsonb_build_array(
         jsonb_build_object('id', 'welcome_back', 'type', 'message', 'label', 'ברוכים השבים', 'text', 'היי {שם פרטי}, טוב לראות אותך שוב! כאן {בוט} מיחידת הבטיחות 😊', 'next', 'topics'),
         jsonb_build_object('id', 'id_saved', 'type', 'message', 'label', 'תודה על הפרטים', 'text', 'תודה {שם פרטי}! שמרתי את הפרטים, כך שבפעם הבאה לא נשאל אותם שוב.', 'next', 'topics')
       )
  ), updated_at = now()
 WHERE s.key = 'flow'
   AND jsonb_typeof(s.value->'nodes') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.value->'nodes') e WHERE e->>'id' = 'start' AND e->>'type' = 'condition' AND e->>'yes' = 'topics' AND e->'check'->>'name' = 'fullName')
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.value->'nodes') e WHERE e->>'id' = 'remember' AND e->>'next' = 'topics')
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.value->'nodes') e WHERE e->>'id' IN ('welcome_back', 'id_saved'));

-- 2) The safety-unit installation without a bot identity yet: the bot is Betty (the picture can be added from the branding page).
INSERT INTO settings (key, value)
SELECT 'bot_persona', '{"name": "בטי", "role": "הבוט של יחידת הבטיחות"}'::jsonb
 WHERE EXISTS (SELECT 1 FROM settings f, jsonb_array_elements(f.value->'nodes') e WHERE f.key = 'flow' AND jsonb_typeof(f.value->'nodes') = 'array' AND e->>'id' = 'welcome_back')
ON CONFLICT (key) DO NOTHING;

-- 3) The untouched default welcome of the menu bot greets by name and names the bot.
UPDATE settings SET value = jsonb_set(value, '{welcome}', to_jsonb(CASE value->>'welcome'
    WHEN 'שלום! אני הבוט של השירות. במה אפשר לעזור? השיבו במספר:' THEN 'שלום {שם פרטי}! כאן {בוט}. במה אפשר לעזור? השיבו במספר:'
    ELSE 'שלום {שם פרטי}! אני בטי, הבוט של יחידת הבטיחות. במה אפשר לעזור? השיבו במספר:' END)), updated_at = now()
 WHERE key = 'bot' AND value->>'welcome' IN ('שלום! אני הבוט של השירות. במה אפשר לעזור? השיבו במספר:', 'שלום! אני בטי, הבוט של יחידת הבטיחות. במה אפשר לעזור? השיבו במספר:');
