/** Migration 16: private feedback and reviewer replies with durable request receipts. */
export const FEEDBACK_SCHEMA_SQL = /* sql */ `
CREATE TABLE feedback_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),status text NOT NULL DEFAULT 'open' CHECK(status IN('open','in_progress','resolved')),
 description text NOT NULL CHECK(char_length(description) BETWEEN 1 AND 2000),diagnostics jsonb,response text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_tickets_owner ON feedback_tickets(user_id,created_at DESC,id);
CREATE INDEX feedback_tickets_queue ON feedback_tickets(status,updated_at,id);
CREATE TABLE feedback_updates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
 reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 status text NOT NULL CHECK(status IN('open','in_progress','resolved')),response text NOT NULL CHECK(char_length(response)<=2000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE feedback_requests (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,client_op_id uuid NOT NULL,
 ticket_id uuid NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,request_hash text NOT NULL,response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,client_op_id)
);
CREATE TRIGGER feedback_ticket_active_user BEFORE INSERT OR UPDATE ON feedback_tickets FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER feedback_request_active_user BEFORE INSERT OR UPDATE ON feedback_requests FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
