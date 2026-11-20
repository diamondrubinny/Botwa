-- Betty greets by the hour: the built-in opening texts start with {ברכה} ("בוקר טוב" / "צהריים טובים" / "ערב טוב" / "לילה טוב")
-- instead of a fixed "שלום" / "היי". Only texts still exactly as shipped are changed; anything the unit edited stays as written.
UPDATE settings s SET value = jsonb_set(s.value, '{nodes}',
    (SELECT jsonb_agg(
        CASE
          WHEN n->>'text' = 'היי {שם פרטי}, טוב לראות אותך שוב! כאן {בוט} מיחידת הבטיחות 😊'
            THEN jsonb_set(n, '{text}', to_jsonb('{ברכה} {שם פרטי}, טוב לראות אותך שוב! כאן {בוט} מיחידת הבטיחות 😊'::text))
          WHEN n->>'id' = 'id_intro' AND n->>'text' LIKE 'שלום, כאן {בוט} מיחידת הבטיחות 👋%'
            THEN jsonb_set(n, '{text}', to_jsonb('{ברכה}, כאן {בוט}' || substr(n->>'text', length('שלום, כאן {בוט}') + 1)))
          ELSE n
        END ORDER BY ord)
       FROM jsonb_array_elements(s.value->'nodes') WITH ORDINALITY AS t(n, ord))
  ), updated_at = now()
 WHERE s.key = 'flow'
   AND jsonb_typeof(s.value->'nodes') = 'array'
   AND (s.value::text LIKE '%היי {שם פרטי}, טוב לראות אותך שוב!%' OR s.value::text LIKE '%שלום, כאן {בוט} מיחידת הבטיחות%');

UPDATE settings SET value = jsonb_set(value, '{welcome}', to_jsonb('{ברכה} {שם פרטי}! כאן {בוט}. במה אפשר לעזור? השיבו במספר:'::text)), updated_at = now()
 WHERE key = 'bot' AND value->>'welcome' = 'שלום {שם פרטי}! כאן {בוט}. במה אפשר לעזור? השיבו במספר:';
