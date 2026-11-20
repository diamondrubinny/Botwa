-- The first loop guard stopped the bot after 8 automatic replies in 10 minutes, which a normal identification reaches.
-- Conversations it stopped, that no person has answered since, go back to the bot (the flow resumes where it was).
WITH stopped AS (
  SELECT c.id, max(n.created_at) AS stopped_at
    FROM conversations c JOIN conversation_notes n ON n.conversation_id = c.id
   WHERE c.status = 'open' AND c.bot_state = 'human'
     AND n.body LIKE 'הבוט נעצר: יותר מדי הודעות אוטומטיות%'
   GROUP BY c.id
), untouched AS (
  SELECT s.id FROM stopped s
   WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = s.id AND m.direction = 'out' AND NOT m.auto AND m.created_at >= s.stopped_at)
     AND NOT EXISTS (SELECT 1 FROM conversation_notes x WHERE x.conversation_id = s.id AND x.created_at > s.stopped_at AND x.body LIKE 'מועבר מהבוט%')
)
UPDATE conversations c
   SET bot_state = 'menu', assigned_to = NULL,
       flow_state = CASE WHEN (c.flow_state->>'done')::boolean IS TRUE THEN NULL ELSE c.flow_state END
  FROM untouched u WHERE c.id = u.id;

INSERT INTO conversation_notes (conversation_id, body)
SELECT c.id, 'הבוט חזר לפעול בשיחה (הוא נעצר בטעות על ידי מנגנון ההגנה הישן).'
  FROM conversations c
 WHERE c.status = 'open' AND c.bot_state = 'menu'
   AND EXISTS (SELECT 1 FROM conversation_notes n WHERE n.conversation_id = c.id AND n.body LIKE 'הבוט נעצר: יותר מדי הודעות אוטומטיות%')
   AND NOT EXISTS (SELECT 1 FROM conversation_notes n WHERE n.conversation_id = c.id AND n.body LIKE 'הבוט חזר לפעול בשיחה%');
