-- A short unique username for every person (e.g. dana.levi), shown as @dana.levi: used to pick people for officers,
-- responsibility areas and hand-overs in the flow chart, and in spreadsheet imports. Generated from the e-mail; editable by admins.
ALTER TABLE users ADD COLUMN username text CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$');

CREATE FUNCTION botwa_unique_username(seed text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE base text; cand text; n int := 1;
BEGIN
  base := regexp_replace(lower(split_part(coalesce(seed, ''), '@', 1)), '[^a-z0-9._-]', '', 'g');
  base := regexp_replace(base, '^[._-]+|[._-]+$', '', 'g');
  IF length(base) < 3 THEN base := 'user' || base; END IF;
  base := left(base, 24);
  base := regexp_replace(base, '[._-]+$', '', 'g');
  cand := base;
  WHILE EXISTS (SELECT 1 FROM users WHERE lower(username) = cand) LOOP
    n := n + 1; cand := base || n;
  END LOOP;
  RETURN cand;
END $$;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id, email FROM users WHERE username IS NULL ORDER BY created_at LOOP
    UPDATE users SET username = botwa_unique_username(r.email) WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX users_username_idx ON users (lower(username));

-- new accounts get one automatically when none is given
CREATE FUNCTION botwa_users_username() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.username IS NULL OR NEW.username = '' THEN NEW.username := botwa_unique_username(NEW.email); END IF;
  NEW.username := lower(NEW.username);
  RETURN NEW;
END $$;
CREATE TRIGGER users_username_default BEFORE INSERT OR UPDATE OF username ON users FOR EACH ROW EXECUTE FUNCTION botwa_users_username();
ALTER TABLE users ALTER COLUMN username SET NOT NULL;
