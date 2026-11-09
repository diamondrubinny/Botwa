-- Flows built from the safety-unit template before the "smart bot" change: switch the new behaviour on once
-- (questions answered from the knowledge base in the first message, in the topics menu and during identification).
-- Only flows with the template's identification and topics nodes that never had the new settings are touched.
UPDATE settings s SET value = jsonb_set(
    s.value || '{"kbFirst": true}'::jsonb,
    '{nodes}',
    (SELECT jsonb_agg(
        CASE
          WHEN n->>'id' IN ('q_name', 'q_building', 'q_room', 'q_faculty', 'q_pi') AND n->>'type' = 'question' THEN n || '{"kbAside": true}'::jsonb
          WHEN n->>'id' = 'topics' AND n->>'type' = 'menu' THEN n || '{"kbOnFreeText": true}'::jsonb
          ELSE n
        END ORDER BY ord)
       FROM jsonb_array_elements(s.value->'nodes') WITH ORDINALITY AS t(n, ord))
  ), updated_at = now()
 WHERE s.key = 'flow'
   AND jsonb_typeof(s.value->'nodes') = 'array'
   AND NOT (s.value ? 'kbFirst')
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.value->'nodes') e WHERE e->>'id' = 'q_name')
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.value->'nodes') e WHERE e->>'id' = 'topics');
