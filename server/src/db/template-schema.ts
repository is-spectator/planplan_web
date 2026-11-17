/** Frozen migration 11. Never regenerate from mutable runtime definitions. */
export const TEMPLATE_SCHEMA_SQL = /* sql */ `
CREATE TABLE template_versions (
  template_id text NOT NULL, version integer NOT NULL CHECK (version > 0), definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (template_id, version)
);
INSERT INTO template_versions (template_id,version,definition) VALUES ('official.reading',1,'{"schemaVersion":1,"id":"official.reading","version":1,"name":"阅读","description":"记录阅读时长，按周查看坚持的天数。书名、阅读位置和收获保存在备注中。","engine":"study","source":"official","requiredCapabilities":["reading-template-v1"],"configurationFields":[{"id":"name","label":"计划名称","type":"text","required":true,"maxLength":20},{"id":"startDate","label":"开始日期","type":"date","required":true},{"id":"currentBook","label":"当前在读","type":"text","required":false,"maxLength":80},{"id":"daysPerWeek","label":"每周目标天数","type":"integer","required":false,"unit":"day_per_week","min":1,"max":7},{"id":"minMinutes","label":"每日目标分钟","type":"duration","required":false,"unit":"minute","min":1,"max":1440}],"recordFields":[{"id":"date","label":"日期","type":"date","required":true},{"id":"minutes","label":"阅读分钟","type":"duration","required":true,"unit":"minute","min":1,"max":1440},{"id":"note","label":"备注","type":"text","required":false,"maxLength":200}],"metrics":[{"id":"totalMinutes","label":"本周阅读分钟","operation":"sum","fieldId":"minutes","period":"week"},{"id":"recordDays","label":"本周记录天数","operation":"distinct_days","fieldId":"date","period":"week"}],"components":["goal","calendar","summary","records"],"example":{"config":{"name":"我的阅读","startDate":"2026-11-16","daysPerWeek":5,"minMinutes":20},"record":{"date":"2026-11-16","minutes":60,"note":"书名：示例书籍\\n阅读位置：第 35 页"}}}'::jsonb);
INSERT INTO template_versions (template_id,version,definition) VALUES ('official.ledger',1,'{"schemaVersion":1,"id":"official.ledger","version":1,"name":"记账","description":"使用唯一人民币账本记录支出与退款，按自然月查看预算。","engine":"ledger","source":"official","requiredCapabilities":["ledger-template-v1"],"configurationFields":[{"id":"budgetCents","label":"每月预算","type":"money","required":false,"unit":"CNY_cent","min":1,"max":99999999}],"recordFields":[{"id":"date","label":"日期","type":"date","required":true},{"id":"recordRole","label":"记录类型","type":"single_select","required":true,"options":["expense","refund"]},{"id":"amountCents","label":"金额","type":"money","required":true,"unit":"CNY_cent","min":1,"max":99999999},{"id":"category","label":"分类","type":"single_select","required":true,"options":["餐饮","交通","购物","居住","学习","娱乐","其他"]},{"id":"refundOf","label":"退款对应原支出","type":"text","required":false,"maxLength":36},{"id":"note","label":"备注","type":"text","required":false,"maxLength":200}],"metrics":[{"id":"amount","label":"本月支出","operation":"sum","fieldId":"amountCents","period":"month","sourceRule":"ledger_expenses"}],"components":["summary","budget","records"],"example":{"config":{"budgetCents":200000},"record":{"date":"2026-11-16","recordRole":"expense","amountCents":2000,"category":"餐饮","note":"示例午饭"}}}'::jsonb);
INSERT INTO template_versions (template_id,version,definition) VALUES ('official.water',1,'{"schemaVersion":1,"id":"official.water","version":1,"name":"饮水","description":"以整数毫升记录饮水量，按日求和。明确的升数按 1 升 = 1000 毫升换算，不猜测杯容量。","engine":"generic","source":"official","requiredCapabilities":["generic-record-v1"],"configurationFields":[{"id":"name","label":"计划名称","type":"text","required":true,"maxLength":20},{"id":"startDate","label":"开始日期","type":"date","required":true},{"id":"dailyGoalMl","label":"每日目标毫升","type":"integer","required":false,"unit":"ml","min":1,"max":100000}],"recordFields":[{"id":"date","label":"日期","type":"date","required":true},{"id":"amountMl","label":"饮水毫升","type":"integer","required":true,"unit":"ml","min":1,"max":100000},{"id":"note","label":"备注","type":"text","required":false,"maxLength":200}],"metrics":[{"id":"dailyMl","label":"今日饮水量","operation":"sum","fieldId":"amountMl","period":"day"},{"id":"progress","label":"目标进度","operation":"goal_progress","fieldId":"amountMl","period":"day","goalFieldId":"dailyGoalMl"}],"components":["summary","goal","records"],"example":{"config":{"name":"饮水","startDate":"2026-11-16","dailyGoalMl":2000},"record":{"date":"2026-11-16","amountMl":500}}}'::jsonb);
INSERT INTO template_versions (template_id,version,definition) VALUES ('legacy.study',1,'{"schemaVersion":1,"id":"legacy.study","version":1,"name":"学习","description":"保留原有学习计划及目标、时长、历史记录。","engine":"study","source":"official","requiredCapabilities":["reading-template-v1"],"configurationFields":[{"id":"name","label":"计划名称","type":"text","required":true,"maxLength":20},{"id":"startDate","label":"开始日期","type":"date","required":true},{"id":"daysPerWeek","label":"每周目标天数","type":"integer","required":false,"unit":"day_per_week","min":1,"max":7},{"id":"minMinutes","label":"每日目标分钟","type":"duration","required":false,"unit":"minute","min":1,"max":1440}],"recordFields":[{"id":"date","label":"日期","type":"date","required":true},{"id":"minutes","label":"阅读分钟","type":"duration","required":true,"unit":"minute","min":1,"max":1440},{"id":"note","label":"备注","type":"text","required":false,"maxLength":200}],"metrics":[{"id":"totalMinutes","label":"本周阅读分钟","operation":"sum","fieldId":"minutes","period":"week"},{"id":"recordDays","label":"本周记录天数","operation":"distinct_days","fieldId":"date","period":"week"}],"components":["goal","calendar","summary","records"],"example":{"config":{"name":"学习","startDate":"2026-11-16"},"record":{"date":"2026-11-16","minutes":60,"note":"书名：示例书籍\\n阅读位置：第 35 页"}}}'::jsonb);
CREATE FUNCTION protect_template_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Template versions are immutable';
END $$;
CREATE TRIGGER template_version_immutable BEFORE UPDATE OR DELETE ON template_versions FOR EACH ROW EXECUTE FUNCTION protect_template_version();
CREATE TABLE plan_template_bindings (
  plan_id uuid PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id text NOT NULL, template_version integer NOT NULL,
  source text NOT NULL CHECK (source IN ('official','legacy')),
  definition_snapshot jsonb NOT NULL, config_version integer NOT NULL DEFAULT 1,
  setup_status text NOT NULL DEFAULT 'pending' CHECK (setup_status IN ('pending','ready')),
  current_book text CHECK (char_length(current_book) <= 80), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (template_id,template_version) REFERENCES template_versions(template_id,version)
);
CREATE INDEX plan_template_bindings_user ON plan_template_bindings(user_id);
INSERT INTO plan_template_bindings (plan_id,user_id,template_id,template_version,source,definition_snapshot,setup_status)
SELECT p.id,p.user_id,'legacy.study',1,'legacy',v.definition,'ready' FROM plans p CROSS JOIN template_versions v
WHERE p.kind='study' AND v.template_id='legacy.study' AND v.version=1;
CREATE TABLE template_operation_requests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_op_id text NOT NULL,
  request_hash text NOT NULL, PRIMARY KEY (user_id,client_op_id)
);
ALTER TABLE goal_segments ADD COLUMN cleared boolean NOT NULL DEFAULT false;
CREATE FUNCTION bump_template_configuration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_TABLE_NAME = 'plans' THEN
    IF (OLD.name,OLD.start_date,OLD.status,OLD.view_config) IS DISTINCT FROM (NEW.name,NEW.start_date,NEW.status,NEW.view_config) THEN
      UPDATE plan_template_bindings SET config_version=config_version+1 WHERE plan_id=NEW.id;
    END IF;
  ELSE
    UPDATE plan_template_bindings SET config_version=config_version+1 WHERE plan_id=COALESCE(NEW.plan_id,OLD.plan_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER plan_template_config_changed AFTER UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION bump_template_configuration();
CREATE TRIGGER goal_template_config_changed AFTER INSERT OR UPDATE OR DELETE ON goal_segments FOR EACH ROW EXECUTE FUNCTION bump_template_configuration();
`;
