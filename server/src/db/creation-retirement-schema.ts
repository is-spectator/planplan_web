/** Migration 17: discard private authoring content without breaking adopted plans. */
export const CREATION_RETIREMENT_SCHEMA_SQL = /* sql */ `
CREATE TABLE retired_private_templates (
 template_id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 draft_id uuid NOT NULL, retired_at timestamptz NOT NULL DEFAULT now(),
 CHECK(template_id LIKE 'private.%'), UNIQUE(user_id,draft_id)
);
CREATE TABLE creation_deleted_requests (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_op_id uuid NOT NULL,
 request_hash text NOT NULL, draft_id uuid NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,client_op_id)
);
CREATE OR REPLACE FUNCTION protect_template_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND OLD.owner_user_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_user_id AND deleted_at IS NULL) THEN RETURN OLD; END IF;
  IF EXISTS(SELECT 1 FROM retired_private_templates WHERE template_id=OLD.template_id AND user_id=OLD.owner_user_id)
   AND NOT EXISTS(SELECT 1 FROM plan_template_bindings WHERE template_id=OLD.template_id AND template_version=OLD.version)
   AND NOT EXISTS(SELECT 1 FROM records WHERE template_id=OLD.template_id AND definition_version=OLD.version)
  THEN RETURN OLD; END IF;
 END IF;
 RAISE EXCEPTION 'Template versions are immutable';
END $$;
CREATE FUNCTION reject_retired_private_template() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM retired_private_templates WHERE template_id=NEW.template_id)
 THEN RAISE EXCEPTION 'Private template has been deleted' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retired_template_insert_guard BEFORE INSERT ON template_versions
 FOR EACH ROW EXECUTE FUNCTION reject_retired_private_template();
CREATE TRIGGER retired_draft_insert_guard BEFORE INSERT OR UPDATE ON creation_drafts
 FOR EACH ROW EXECUTE FUNCTION reject_retired_private_template();
CREATE TRIGGER retired_template_active_user BEFORE INSERT OR UPDATE ON retired_private_templates
 FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER deleted_creation_request_active_user BEFORE INSERT OR UPDATE ON creation_deleted_requests
 FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
