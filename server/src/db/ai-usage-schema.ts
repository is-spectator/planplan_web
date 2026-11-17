/** 个人调用明细级联删除；匿名财务汇总与幂等凭据不关联用户。 */
export const AI_USAGE_SCHEMA_SQL = /* sql */ `
CREATE TABLE ai_monthly_usage (
  month text PRIMARY KEY CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  attempts bigint NOT NULL DEFAULT 0,
  pending_attempts bigint NOT NULL DEFAULT 0,
  unknown_cost_attempts bigint NOT NULL DEFAULT 0,
  known_cost_pico numeric(30,0) NOT NULL DEFAULT 0
);
CREATE TABLE ai_usage_receipts (
  attempt_id uuid PRIMARY KEY,
  month text NOT NULL REFERENCES ai_monthly_usage(month),
  pending_since timestamptz,
  finalized boolean NOT NULL DEFAULT false,
  cost_pico numeric(30,0),
  cost_status text NOT NULL DEFAULT 'pending',
  stale_alerted boolean NOT NULL DEFAULT false
);
CREATE INDEX ai_usage_pending ON ai_usage_receipts(pending_since) WHERE NOT finalized;
CREATE TABLE ai_attempts (
  attempt_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  role text NOT NULL CHECK (role IN ('primary', 'fallback')),
  model text NOT NULL,
  output_mode text NOT NULL,
  prompt_version text NOT NULL,
  protocol_version text NOT NULL,
  started_at timestamptz NOT NULL,
  latency_ms integer,
  outcome text NOT NULL DEFAULT 'pending',
  error_code text,
  prompt_tokens bigint,
  completion_tokens bigint,
  cached_prompt_tokens bigint,
  price_version text,
  cost_status text NOT NULL DEFAULT 'pending',
  cost_pico numeric(30,0)
);
CREATE INDEX ai_attempts_user_time ON ai_attempts(user_id, started_at);
CREATE INDEX ai_attempts_request ON ai_attempts(user_id, request_hash);
CREATE INDEX ai_attempts_retention ON ai_attempts(started_at);
CREATE TABLE ai_cost_alerts (
  month text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, kind)
);
`;
