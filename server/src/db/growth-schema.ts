/** 010: Growth data follows account deletion; earned points survive record undo. */
export const GROWTH_SCHEMA_SQL = `
-- 成长小屋：每条新增的支出或学习记录一行，按录入当天计；points 为 0 表示超过每日上限。
CREATE TABLE growth_points (
  record_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  earned_on text NOT NULL,
  points integer NOT NULL CHECK (points IN (0, 1)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX growth_points_user_day ON growth_points(user_id, earned_on);

CREATE TABLE house_items (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot text NOT NULL,
  variant text,
  unlocked_on text NOT NULL,
  memory text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slot)
);

CREATE TABLE weekly_captions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week text NOT NULL,
  caption text NOT NULL,
  PRIMARY KEY (user_id, week)
);

CREATE TABLE circles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 每人最多加入一个同行榜；eligible_from 为开始计入排名的周（周一）。
CREATE TABLE circle_members (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  circle_id uuid NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  nickname text NOT NULL,
  eligible_from text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX circle_members_circle ON circle_members(circle_id);

CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON growth_points FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON house_items FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON weekly_captions FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON circle_members FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();

-- Account purge and recovery replay both cascade membership deletion. Serialize with joins
-- so the last departure also removes the circle name and invitation code.
CREATE FUNCTION planplan_remove_empty_circle() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM circles WHERE id = OLD.circle_id FOR UPDATE;
  DELETE FROM circles WHERE id = OLD.circle_id AND NOT EXISTS (SELECT 1 FROM circle_members WHERE circle_id = OLD.circle_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER remove_empty_circle AFTER DELETE ON circle_members FOR EACH ROW EXECUTE FUNCTION planplan_remove_empty_circle();
`;
