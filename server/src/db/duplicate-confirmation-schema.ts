/** Nonces are account-scoped and bound to a digest of the original request, never extra fact text. */
export const DUPLICATE_CONFIRMATION_SCHEMA_SQL = `
CREATE TABLE operation_confirmations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_op_id text NOT NULL,
  confirmation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  intent_hash text NOT NULL CHECK (length(intent_hash)=64),
  input_at timestamptz NOT NULL,
  duplicate_count integer NOT NULL CHECK (duplicate_count BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  PRIMARY KEY (user_id, client_op_id)
);
CREATE INDEX operation_confirmations_expiry ON operation_confirmations(expires_at);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON operation_confirmations FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
