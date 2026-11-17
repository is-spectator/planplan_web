/** Migration 003. Challenges contain keyed email digests, never raw emails or codes. */
export const EMAIL_AUTH_SCHEMA_SQL = /* sql */ `
CREATE TABLE email_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE email_auth_challenges (
  id uuid PRIMARY KEY,
  email_key text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register', 'reset')),
  code_hash text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  eligible boolean NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_auth_challenges_expiry ON email_auth_challenges(expires_at);
CREATE INDEX email_auth_challenges_email ON email_auth_challenges(email_key, purpose);
CREATE TABLE email_auth_limits (
  key text PRIMARY KEY,
  hits timestamptz[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_auth_limits_expiry ON email_auth_limits(updated_at);
`;
