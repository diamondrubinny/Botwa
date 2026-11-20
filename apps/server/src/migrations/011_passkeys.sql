-- WebAuthn passkeys (phishing-resistant sign-in). A passkey with user verification also satisfies the MFA requirement.
CREATE TABLE passkeys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,          -- base64url
  public_key    bytea NOT NULL,                -- COSE public key
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[],
  device_type   text,                          -- singleDevice | multiDevice
  backed_up     boolean NOT NULL DEFAULT false,
  name          text NOT NULL DEFAULT 'Passkey',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);

-- one-time challenges (5 minutes)
CREATE TABLE webauthn_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('register', 'login')),
  challenge  text NOT NULL,
  expires_at timestamptz NOT NULL
);
