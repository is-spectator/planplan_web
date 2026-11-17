/** Migration 13: private authoring and record definition provenance. Prior migrations remain frozen. */
export const CREATION_SCHEMA_SQL = /* sql */ `
ALTER TABLE template_versions ADD COLUMN owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX template_versions_owner ON template_versions(owner_user_id,template_id,version);
CREATE OR REPLACE FUNCTION protect_template_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' AND OLD.owner_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id=OLD.owner_user_id AND deleted_at IS NULL
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Template versions are immutable';
END $$;
CREATE FUNCTION private_template_active_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.owner_user_id IS NOT NULL THEN
    PERFORM 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account no longer accepts writes' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER private_template_active_user BEFORE INSERT ON template_versions FOR EACH ROW EXECUTE FUNCTION private_template_active_user();
ALTER TABLE plan_template_bindings DROP CONSTRAINT plan_template_bindings_source_check;
ALTER TABLE plan_template_bindings ADD CONSTRAINT plan_template_bindings_source_check CHECK (source IN ('official','legacy','private'));
ALTER TABLE records ADD COLUMN template_id text;
UPDATE records r SET template_id=b.template_id FROM plan_template_bindings b WHERE r.kind='generic' AND r.plan_id=b.plan_id;
ALTER TABLE records ADD CONSTRAINT generic_record_template_source CHECK (kind<>'generic' OR template_id IS NOT NULL);
ALTER TABLE records ADD CONSTRAINT records_template_definition_fk FOREIGN KEY(template_id,definition_version) REFERENCES template_versions(template_id,version);

CREATE TABLE creation_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id text NOT NULL UNIQUE, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  definition jsonb, definition_revision integer, next_revision integer NOT NULL DEFAULT 0,
  change_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  saved_template_version integer, saved_definition_hash text,
  source_plan_id uuid REFERENCES plans(id) ON DELETE SET NULL, source_plan_version integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creation_drafts_user ON creation_drafts(user_id,updated_at DESC,id);
CREATE TABLE creation_revisions (
  draft_id uuid NOT NULL REFERENCES creation_drafts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision>0), parent_revision integer,
  definition jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(draft_id,revision)
);
CREATE TABLE creation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq integer GENERATED ALWAYS AS IDENTITY,
  draft_id uuid NOT NULL REFERENCES creation_drafts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('user','assistant')), text text NOT NULL CHECK(char_length(text) BETWEEN 1 AND 6000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creation_messages_draft ON creation_messages(draft_id,seq);
CREATE TABLE creation_requests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_op_id uuid NOT NULL,
  request_hash text NOT NULL, status text NOT NULL CHECK(status IN ('processing','succeeded','retryable','failed')),
  request jsonb NOT NULL, response jsonb, error jsonb, lease_token uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,client_op_id)
);
CREATE TRIGGER creation_draft_active_user BEFORE INSERT OR UPDATE ON creation_drafts FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER creation_revision_active_user BEFORE INSERT OR UPDATE ON creation_revisions FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER creation_message_active_user BEFORE INSERT OR UPDATE ON creation_messages FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER creation_request_active_user BEFORE INSERT OR UPDATE ON creation_requests FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
