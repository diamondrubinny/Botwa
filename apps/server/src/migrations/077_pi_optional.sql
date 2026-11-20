-- The safety flow: the PI's name may be skipped, and a head of unit counts too ("שם ה-PI (מחזיק המעבדה) / ראש יחידה").
-- Saved flows from the template: the question becomes optional; its wording changes only where it is still the template's own.
UPDATE settings s SET value = jsonb_set(s.value, '{nodes}',
    (SELECT jsonb_agg(
        CASE
          WHEN n->>'id' = 'q_pi' AND n->>'type' = 'question' AND n->>'text' = 'שם ה-PI (מחזיק המעבדה):'
            THEN n || jsonb_build_object('optional', true, 'text', 'שם ה-PI (מחזיק המעבדה) / ראש יחידה (אפשר לכתוב "דלג"):', 'retryText', 'נא לכתוב את שם ה-PI או ראש היחידה, או "דלג".')
          WHEN n->>'id' = 'q_pi' AND n->>'type' = 'question' THEN n || jsonb_build_object('optional', true)
          ELSE n
        END ORDER BY ord)
       FROM jsonb_array_elements(s.value->'nodes') WITH ORDINALITY AS t(n, ord))
  ), updated_at = now()
 WHERE s.key = 'flow'
   AND jsonb_typeof(s.value->'nodes') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.value->'nodes') e WHERE e->>'id' = 'q_pi' AND e->>'type' = 'question');
