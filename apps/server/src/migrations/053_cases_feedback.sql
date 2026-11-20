-- Every inquiry a customer opened: a case runs from the moment a conversation (re)opens until it is closed. Kept by triggers, so
-- whatever closes or reopens a conversation (a person, an automation, a new customer message) is recorded the same way.
CREATE TABLE cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,      -- a short reference ("פנייה #1042")
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  close_kind      text CHECK (close_kind IN ('staff', 'auto', 'other')),
  closed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_to     uuid REFERENCES users(id) ON DELETE SET NULL,     -- who had it when it closed
  first_message   text,                                             -- the customer's first words (what it was about)
  rating          smallint CHECK (rating BETWEEN 1 AND 5),          -- the customer's feedback, if given
  rated_at        timestamptz
);
CREATE INDEX cases_conversation_idx ON cases (conversation_id, opened_at DESC);
CREATE UNIQUE INDEX cases_one_open ON cases (conversation_id) WHERE closed_at IS NULL;

-- who / what closed it (set by the code that closes; read by the trigger)
ALTER TABLE conversations ADD COLUMN close_kind text CHECK (close_kind IN ('staff', 'auto', 'other'));
ALTER TABLE conversations ADD COLUMN closed_by uuid REFERENCES users(id) ON DELETE SET NULL;
-- the feedback question waiting for an answer (a rating 1-5 does not reopen the conversation)
ALTER TABLE conversations ADD COLUMN feedback_case_id uuid REFERENCES cases(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN feedback_asked_at timestamptz;

CREATE FUNCTION cases_on_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'open' THEN INSERT INTO cases (conversation_id) VALUES (NEW.id); END IF;
  ELSIF NEW.status = 'closed' AND OLD.status = 'open' THEN
    UPDATE cases SET closed_at = now(), close_kind = COALESCE(NEW.close_kind, 'other'), closed_by = NEW.closed_by, assigned_to = NEW.assigned_to
     WHERE conversation_id = NEW.id AND closed_at IS NULL;
  ELSIF NEW.status = 'open' AND OLD.status = 'closed' THEN
    -- reopened by a customer message: that message is already stored, and is what the new case is about
    INSERT INTO cases (conversation_id, first_message, opened_at)
    SELECT NEW.id, left(m.body, 200), LEAST(m.created_at, now())
      FROM (SELECT body, created_at FROM messages WHERE conversation_id = NEW.id AND direction = 'in' ORDER BY created_at DESC LIMIT 1) m
    UNION ALL SELECT NEW.id, NULL, now() WHERE NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = NEW.id AND direction = 'in')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversations_cases AFTER INSERT OR UPDATE OF status ON conversations FOR EACH ROW EXECUTE FUNCTION cases_on_conversation();

-- the first customer message of a case says what it is about
CREATE FUNCTION cases_first_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- the case starts when the customer wrote (platform time, which can be earlier than when it reached us), not when it was stored
  IF NEW.direction = 'in' THEN
    UPDATE cases SET first_message = COALESCE(first_message, NULLIF(left(COALESCE(NEW.body, ''), 200), '')), opened_at = LEAST(opened_at, NEW.created_at)
     WHERE conversation_id = NEW.conversation_id AND closed_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_case_first AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION cases_first_message();

-- the conversations that exist today: one case each (open ones still running, closed ones closed at their last message)
INSERT INTO cases (conversation_id, opened_at, closed_at, close_kind, assigned_to, first_message)
SELECT c.id,
       COALESCE((SELECT min(created_at) FROM messages m WHERE m.conversation_id = c.id), c.last_message_at, now()),
       CASE WHEN c.status = 'closed' THEN COALESCE(c.last_message_at, now()) END,
       CASE WHEN c.status = 'closed' THEN 'other' END,
       c.assigned_to,
       (SELECT left(body, 200) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in' AND body <> '' ORDER BY created_at LIMIT 1)
  FROM conversations c;

-- the feedback question is an automatic message too
ALTER TABLE messages DROP CONSTRAINT messages_automation_check;
ALTER TABLE messages ADD CONSTRAINT messages_automation_check CHECK (automation IN ('idle_reminder', 'idle_close', 'holding', 'closing', 'feedback', 'feedback_thanks'));
