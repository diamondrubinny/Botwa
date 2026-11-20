-- Saved safety flows: a customer counts as known once the identification is complete (its last answer, the status). Each detail
-- is now saved as soon as it is given, so someone who stopped half-way is asked only what is still missing.
UPDATE settings s SET value = jsonb_set(s.value, '{nodes}',
    (SELECT jsonb_agg(
        CASE WHEN n->>'id' = 'start' AND n->>'type' = 'condition' AND n->'check'->>'kind' = 'has' AND n->'check'->>'name' = 'fullName'
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.value->'nodes') e WHERE e->>'id' = 'remember' AND e->'vars' ? 'status')
             THEN jsonb_set(n, '{check,name}', '"status"') ELSE n END ORDER BY ord)
       FROM jsonb_array_elements(s.value->'nodes') WITH ORDINALITY AS t(n, ord))
  ), updated_at = now()
 WHERE s.key = 'flow' AND jsonb_typeof(s.value->'nodes') = 'array';

-- Information topics (forms) end with their answer and a line on going on, instead of sending the whole menu again under it.
UPDATE settings s SET value = jsonb_set(s.value, '{nodes}',
    (SELECT jsonb_agg(
        CASE WHEN n->>'id' IN ('waste', 'accident', 'event', 'offsite') AND n->>'type' = 'message' AND n->>'next' = 'topics'
             THEN (n - 'next') || jsonb_build_object('text', (n->>'text') || E'\n\nלנושא נוסף אפשר לכתוב אותו כאן במילים, או "תפריט" לתפריט הראשי.')
             ELSE n END ORDER BY ord)
       FROM jsonb_array_elements(s.value->'nodes') WITH ORDINALITY AS t(n, ord))
  ), updated_at = now()
 WHERE s.key = 'flow' AND jsonb_typeof(s.value->'nodes') = 'array';
