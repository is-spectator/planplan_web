/** 不外键关联 users：清除业务数据后仍保留最小任务/恢复删除清单。 */
export const LIFECYCLE_SCHEMA_SQL = /* sql */ `
CREATE TABLE deletion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  backup_deadline timestamptz NOT NULL DEFAULT now() + interval '30 days',
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text
);
CREATE INDEX deletion_jobs_pending ON deletion_jobs(requested_at) WHERE status = 'pending';

CREATE FUNCTION planplan_active_user_write() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account no longer accepts writes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON pending_actions FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE FUNCTION planplan_deleted_user_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Deleted account cannot be reactivated' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER deleted_user_immutable BEFORE UPDATE ON users FOR EACH ROW
  WHEN (OLD.deleted_at IS NOT NULL) EXECUTE FUNCTION planplan_deleted_user_immutable();
`;

export const LIFECYCLE_DOWN_SQL = /* sql */ `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM deletion_jobs) THEN
    RAISE EXCEPTION 'Cannot roll back deletion tracking with retained deletion requests';
  END IF;
END $$;
DROP TRIGGER active_user_write ON plans;
DROP TRIGGER active_user_write ON records;
DROP TRIGGER active_user_write ON operations;
DROP TRIGGER active_user_write ON messages;
DROP TRIGGER active_user_write ON pending_actions;
DROP FUNCTION planplan_active_user_write();
DROP TRIGGER deleted_user_immutable ON users;
DROP FUNCTION planplan_deleted_user_immutable();
DROP TABLE deletion_jobs;
`;
