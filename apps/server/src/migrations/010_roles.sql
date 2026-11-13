CREATE TABLE roles (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  permissions  text[] NOT NULL DEFAULT '{}',
  builtin      boolean NOT NULL DEFAULT false,
  mfa_required boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- built-in roles; their permission sets are enforced from code (BUILTIN_ROLES) at every start, the rows exist for the foreign key
INSERT INTO roles (key, name, permissions, builtin, mfa_required) VALUES
  ('admin', 'מנהל', '{}', true, true),
  ('supervisor', 'מפקח', '{}', true, true),
  ('agent', 'נציג', '{}', true, false);
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_fk FOREIGN KEY (role) REFERENCES roles(key) ON UPDATE CASCADE;
