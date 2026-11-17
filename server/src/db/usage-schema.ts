/** 007: product events contain allowlisted facts only; identity is deletable. */
export const USAGE_SCHEMA_SQL = `
CREATE TABLE usage_actors (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  first_authenticated_at timestamptz
);
CREATE TABLE usage_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES usage_actors(actor_id) ON DELETE CASCADE,
  name text NOT NULL,
  event_key text NOT NULL CHECK (length(event_key) = 64),
  props jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, name, event_key)
);
CREATE INDEX usage_events_time ON usage_events(created_at);
CREATE INDEX usage_events_actor_time ON usage_events(actor_id, created_at);
-- Legacy events cannot be linked to deletion requests, and clarification.issue
-- could contain personal content. Do not invent identity or import these rows.
DELETE FROM events;
`;
