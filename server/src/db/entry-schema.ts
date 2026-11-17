/** 008: no pre-login text, email, IP or device hardware identifiers. */
export const ENTRY_SCHEMA_SQL = `
ALTER TABLE usage_actors ADD COLUMN first_entry_at timestamptz;
CREATE TABLE usage_entries (
  entry_id uuid PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES usage_actors(actor_id) ON DELETE CASCADE,
  returning_user boolean NOT NULL DEFAULT false
);
CREATE INDEX usage_entries_expiry ON usage_entries(first_seen_at);
CREATE UNIQUE INDEX usage_entries_new_actor ON usage_entries(actor_id) WHERE actor_id IS NOT NULL AND NOT returning_user;
CREATE TABLE usage_request_links (
  actor_id uuid NOT NULL REFERENCES usage_actors(actor_id) ON DELETE CASCADE,
  request_hash text NOT NULL CHECK(length(request_hash)=64),
  root_hash text NOT NULL CHECK(length(root_hash)=64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,request_hash)
);
CREATE INDEX usage_request_roots ON usage_request_links(actor_id,root_hash);
`;
