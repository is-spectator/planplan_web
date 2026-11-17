/** Migration 12 is additive; migration 11 and its immutable version seeds stay unchanged. */
export const GENERIC_TEMPLATE_SCHEMA_SQL = /* sql */ `
ALTER TABLE plans DROP CONSTRAINT plans_kind_check;
ALTER TABLE plans ADD CONSTRAINT plans_kind_check CHECK (kind IN ('ledger','study','generic'));
ALTER TABLE records DROP CONSTRAINT records_kind_check;
ALTER TABLE records ADD CONSTRAINT records_kind_check CHECK (kind IN ('expense','refund','study','generic'));
ALTER TABLE records ADD COLUMN fields jsonb;
ALTER TABLE records ADD COLUMN definition_version integer;
ALTER TABLE records ADD CONSTRAINT generic_record_shape CHECK (kind <> 'generic' OR
  (fields IS NOT NULL AND jsonb_typeof(fields)='object' AND definition_version IS NOT NULL AND definition_version>0
   AND amount_cents IS NULL AND minutes IS NULL AND category IS NULL AND refund_of IS NULL));
ALTER TABLE plan_template_bindings ADD COLUMN config_values jsonb NOT NULL DEFAULT '{}'::jsonb;
INSERT INTO plan_template_bindings (plan_id,user_id,template_id,template_version,source,definition_snapshot,setup_status)
SELECT p.id,p.user_id,'official.ledger',1,'legacy',v.definition,'ready' FROM plans p CROSS JOIN template_versions v
WHERE p.kind='ledger' AND v.template_id='official.ledger' AND v.version=1 ON CONFLICT (plan_id) DO NOTHING;
CREATE TABLE generic_goal_segments (
  seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  field_id text NOT NULL, value jsonb NOT NULL, from_date text NOT NULL, to_date text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generic_goal_segments_plan ON generic_goal_segments(plan_id,seq);
CREATE TRIGGER generic_goal_template_config_changed AFTER INSERT OR UPDATE OR DELETE ON generic_goal_segments
FOR EACH ROW EXECUTE FUNCTION bump_template_configuration();
CREATE TRIGGER generic_request_active_user BEFORE INSERT OR UPDATE ON template_operation_requests
FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
