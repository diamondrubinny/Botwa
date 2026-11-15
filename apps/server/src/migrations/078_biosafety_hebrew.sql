-- The safety flow's topic "Biosafety" in Hebrew ("בטיחות ביולוגית"): an English word in a Hebrew menu sits on the wrong side in
-- WhatsApp. Menu options and node names in saved flows; the tag (shared with the SafetyBoard topics) stays as it is.
UPDATE settings s SET value = jsonb_set(s.value, '{nodes}',
    (SELECT jsonb_agg(
        CASE
          WHEN n->>'type' = 'menu' AND jsonb_typeof(n->'options') = 'array' THEN
            jsonb_set(CASE WHEN n->>'label' = 'Biosafety' THEN jsonb_set(n, '{label}', '"בטיחות ביולוגית"') ELSE n END, '{options}',
              (SELECT jsonb_agg(CASE WHEN o->>'label' = 'Biosafety' THEN jsonb_set(o, '{label}', '"בטיחות ביולוגית"') ELSE o END ORDER BY oo)
                 FROM jsonb_array_elements(n->'options') WITH ORDINALITY AS x(o, oo)))
          WHEN n->>'label' = 'Biosafety' THEN jsonb_set(n, '{label}', '"בטיחות ביולוגית"')
          ELSE n
        END ORDER BY ord)
       FROM jsonb_array_elements(s.value->'nodes') WITH ORDINALITY AS t(n, ord))
  ), updated_at = now()
 WHERE s.key = 'flow'
   AND jsonb_typeof(s.value->'nodes') = 'array'
   AND s.value::text LIKE '%"Biosafety"%';
