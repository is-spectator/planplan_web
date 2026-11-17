/** V1 数据结构。所有业务日期以 'YYYY-MM-DD' 文本保存，避免驱动做时区换算。 */
export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apple_sub text UNIQUE,
  dev_name text UNIQUE,
  ai_consent boolean NOT NULL DEFAULT false,
  ai_consent_at timestamptz,
  token_version integer NOT NULL DEFAULT 0,
  data_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('ledger', 'study')),
  name text NOT NULL,
  activity text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  start_date text NOT NULL,
  view_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS plans_one_ledger ON plans(user_id) WHERE kind = 'ledger';

CREATE TABLE IF NOT EXISTS goal_segments (
  seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  param text NOT NULL CHECK (param IN ('budget_cents', 'days_per_week', 'min_minutes')),
  value integer NOT NULL,
  from_period text NOT NULL,
  to_period text,
  operation_id uuid,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_lifecycle (
  seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('archived', 'restored')),
  on_date text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('expense', 'refund', 'study')),
  amount_cents integer,
  minutes integer,
  category text,
  occurred_on text NOT NULL,
  note text NOT NULL DEFAULT '',
  refund_of uuid REFERENCES records(id),
  source text NOT NULL CHECK (source IN ('chat', 'form')),
  source_message_id uuid,
  input_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS records_plan_date ON records(plan_id, occurred_on) WHERE NOT deleted;

CREATE TABLE IF NOT EXISTS operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_op_id text NOT NULL,
  kind text NOT NULL,
  result jsonb NOT NULL,
  undo jsonb,
  undone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_op_id)
);

ALTER TABLE operations ADD COLUMN IF NOT EXISTS undone_records jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  text text NOT NULL DEFAULT '',
  cards jsonb NOT NULL DEFAULT '[]'::jsonb,
  scope_plan_id uuid,
  operation_id uuid,
  client_msg_id text,
  reply_to uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_user_time ON messages(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id ON messages(user_id, client_msg_id) WHERE role = 'user';

CREATE TABLE IF NOT EXISTS pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid,
  draft jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'cancelled')),
  input_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  props jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
