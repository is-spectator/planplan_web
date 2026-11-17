/** Migration 14 only adds metadata; all previous facts and rule intervals stay intact. */
export const GENERIC_V2_SCHEMA_SQL = /* sql */ `
ALTER TABLE plan_template_bindings ADD COLUMN record_defaults jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(record_defaults)='object');
ALTER TABLE records ADD COLUMN defaulted_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(defaulted_fields)='array');
ALTER TABLE generic_goal_segments ADD COLUMN period text NOT NULL DEFAULT 'day' CHECK(period IN ('day','week','month'));
CREATE INDEX generic_goal_segments_period ON generic_goal_segments(plan_id,field_id,period,from_date,seq);
`;
