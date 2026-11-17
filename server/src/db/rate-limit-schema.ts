/** Only HMAC pseudonyms and one minute of request times; no IP/email/UUID. */
export const RATE_LIMIT_SCHEMA_SQL = `
CREATE TABLE request_rate_limits (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  hits timestamptz[] NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX request_rate_limits_expiry ON request_rate_limits (expires_at);
`;
