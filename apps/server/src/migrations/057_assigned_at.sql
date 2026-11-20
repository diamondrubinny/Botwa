-- Since when the current person handles the conversation ("מטפל/ת: דנה, מ-10:32"). Kept by a trigger so every way of
-- assigning (routing, hand-over, a person taking it, the bot handing over) sets it the same way.
ALTER TABLE conversations ADD COLUMN assigned_at timestamptz;

CREATE OR REPLACE FUNCTION conversations_assigned_at() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.assigned_at := CASE WHEN NEW.assigned_to IS NULL THEN NULL ELSE now() END;
  ELSIF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    NEW.assigned_at := CASE WHEN NEW.assigned_to IS NULL THEN NULL ELSE now() END;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_assigned_at BEFORE INSERT OR UPDATE OF assigned_to ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_assigned_at();

-- existing assignments: the best known time is the last message
UPDATE conversations SET assigned_at = last_message_at WHERE assigned_to IS NOT NULL AND assigned_at IS NULL;
