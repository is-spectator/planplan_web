/** Migration 15: reviewed public snapshots outlive their author's account. */
export const COMMUNITY_SCHEMA_SQL = /* sql */ `
ALTER TABLE creation_drafts ADD COLUMN source_template_id text;
ALTER TABLE creation_drafts ADD COLUMN source_template_version integer;
ALTER TABLE creation_drafts ADD COLUMN publish_eligible boolean NOT NULL DEFAULT false;
UPDATE creation_drafts d SET publish_eligible=true FROM creation_requests r
 WHERE r.user_id=d.user_id AND r.status='succeeded' AND r.request->>'action'='create'
 AND r.response->'draft'->>'id'=d.id::text;
UPDATE creation_drafts d SET source_template_id=r.request->>'sourceTemplateId',
 source_template_version=NULLIF(r.request->>'sourceTemplateVersion','')::integer,publish_eligible=false
 FROM creation_requests r WHERE r.user_id=d.user_id AND r.status='succeeded'
 AND r.request->>'action'='fork' AND r.response->'draft'->>'id'=d.id::text;
UPDATE creation_drafts SET publish_eligible=false WHERE source_plan_id IS NOT NULL;
ALTER TABLE creation_drafts ALTER COLUMN publish_eligible SET DEFAULT true;
ALTER TABLE plan_template_bindings DROP CONSTRAINT plan_template_bindings_source_check;
ALTER TABLE plan_template_bindings ADD CONSTRAINT plan_template_bindings_source_check CHECK(source IN('official','legacy','private','community'));
CREATE TABLE community_listings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 source_template_id text,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 status text NOT NULL DEFAULT 'unlisted' CHECK(status IN('unlisted','listed','suspended','author_deleted')),
 title text,description text,category text CHECK(category IN('finance','reading','health','learning','life','other')),
 author_name text,recommended_version integer,moderation_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,
 UNIQUE(owner_user_id,source_template_id)
);
CREATE INDEX community_listings_catalog ON community_listings(status,published_at DESC,id);
CREATE INDEX community_listings_author ON community_listings(owner_user_id,updated_at DESC,id);
CREATE TABLE community_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 listing_id uuid NOT NULL REFERENCES community_listings(id),listing_version integer NOT NULL,
 source_template_id text NOT NULL,source_template_version integer NOT NULL,
 public_payload jsonb NOT NULL,public_hash text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE community_submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 listing_id uuid NOT NULL REFERENCES community_listings(id),preview_id uuid NOT NULL UNIQUE REFERENCES community_previews(id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','withdrawn','published')),
 public_payload jsonb NOT NULL,public_hash text NOT NULL,
 source_template_id text NOT NULL,source_template_version integer NOT NULL,
 rejection_reason text,published_version integer,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX community_one_open_submission ON community_submissions(listing_id) WHERE status IN('pending','approved');
CREATE INDEX community_submission_queue ON community_submissions(status,created_at,id);
CREATE TABLE community_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),submission_id uuid NOT NULL REFERENCES community_submissions(id) ON DELETE CASCADE,
 reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,decision text NOT NULL CHECK(decision IN('approved','rejected')),
 reason text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE community_publications (
 listing_id uuid NOT NULL REFERENCES community_listings(id),template_id text NOT NULL,template_version integer NOT NULL,
 submission_id uuid REFERENCES community_submissions(id) ON DELETE SET NULL,published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(listing_id,template_version),UNIQUE(template_id,template_version),
 FOREIGN KEY(template_id,template_version) REFERENCES template_versions(template_id,version)
);
CREATE TABLE community_adoptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),listing_id uuid NOT NULL,template_version integer NOT NULL,
 plan_id uuid UNIQUE REFERENCES plans(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(listing_id,template_version) REFERENCES community_publications(listing_id,template_version)
);
CREATE INDEX community_adoptions_listing ON community_adoptions(listing_id);
CREATE TABLE community_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 listing_id uuid NOT NULL REFERENCES community_listings(id),template_version integer NOT NULL,
 reason text NOT NULL CHECK(reason IN('privacy','misleading','unsafe','other')),details text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'open' CHECK(status IN('open','dismissed','actioned')),
 resolution_reason text,reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX community_one_open_report ON community_reports(reporter_user_id,listing_id) WHERE status='open';
CREATE TABLE community_requests (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,client_op_id uuid NOT NULL,request_hash text NOT NULL,
 response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,client_op_id)
);
CREATE FUNCTION community_submission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (OLD.public_payload,OLD.public_hash,OLD.source_template_id,OLD.source_template_version,OLD.owner_user_id,OLD.listing_id,OLD.preview_id)
 IS DISTINCT FROM (NEW.public_payload,NEW.public_hash,NEW.source_template_id,NEW.source_template_version,NEW.owner_user_id,NEW.listing_id,NEW.preview_id)
 THEN RAISE EXCEPTION 'Submitted public content is immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER community_submission_content_guard BEFORE UPDATE ON community_submissions FOR EACH ROW EXECUTE FUNCTION community_submission_immutable();
CREATE FUNCTION community_author_unavailable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
  UPDATE community_listings SET owner_user_id=NULL,source_template_id=NULL,status='author_deleted',title=NULL,description=NULL,
   category=NULL,author_name=NULL,moderation_reason=NULL,version=version+1,updated_at=now() WHERE owner_user_id=OLD.id;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER community_author_deactivated AFTER UPDATE OF deleted_at ON users FOR EACH ROW EXECUTE FUNCTION community_author_unavailable();
CREATE TRIGGER community_author_deleted BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION community_author_unavailable();
`;
