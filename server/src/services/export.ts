import { recordView } from './views.js';
import { zipSync, strToU8 } from 'fflate';
import type { Queryable } from '../db/db.js';
import { listPlans, planRecords, segments } from './repo.js';
import { exportTemplatePlans } from './templates.js';
import { shanghaiDate } from '../domain/time.js';
import { exportCreationData } from './creation-drafts.js';
import { exportCommunityData } from './community.js';
import { exportFeedbackData } from './feedback.js';

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

const README = `PlanPlan 数据导出

时间口径：所有日期均为 Asia/Shanghai（北京时间）的业务日期，格式 YYYY-MM-DD。
金额：单位为人民币元（CNY），保留两位小数；系统内部以“分”精确保存。
时长：单位为分钟。

文件：
- plans.json：计划、状态、开始日期，以及目标规则（每条规则的生效区间与数值）。
  规则区间 from_period / to_period：预算为 YYYY-MM（自然月），学习目标为该周周一的日期；to_period 为空表示一直生效。
  同一周期被多条规则覆盖时，以创建顺序最晚（seq 最大）的为准。
- expenses_refunds.csv：有效的支出与退款。退款的 refund_of 为原支出 id，分类跟随原支出。
- study.csv：有效的学习记录，每行是一次活动的新增时长。
- generic-records.json：通用模板的有效记录；fields 按模板稳定字段 ID 保存，数值使用模板声明的规范单位；defaultedFields列出新增时沿用已启用设置的字段。
- generic_rules：通用目标的日期生效区段，period为day/week/month，周一开始、月为自然月；JSON null明确表示未设置目标，同字段由最新seq决定。
- templates.json：私人计划绑定的不可变模板定义、配置、初始化状态及来源版本。
- private-templates.json：自己保存的私人模板及不可变版本。
- creation-drafts.json：自己的创作草稿、对话和修改历史；独立试填内容不会保存或导出。
- community.json：自己的发布作品、申请、举报及自己计划的社区来源，不包含其他使用者的明细。
- feedback.json：自己主动提交的反馈、已确认的页面诊断和处理答复。
- 规则 cleared=true 表示该区段明确清除目标；其 value 不表示目标，显示为未设置。
- growth.json：成长小屋——累计行动力、已解锁物品与解锁时的回忆、每周拍立得上选的那句话、同行榜昵称。

只包含有效记录；已删除的记录与操作历史不在常规导出中。
`;

export async function buildExport(q: Queryable, userId: string): Promise<Uint8Array> {
  const plans = await listPlans(q, userId);
  const planJson = [];
  const genericRecords=[];
  const money: unknown[][] = [['id', 'type', 'date', 'amount_cny', 'currency', 'category', 'note', 'refund_of', 'plan', 'source', 'created_at']];
  const study: unknown[][] = [['id', 'date', 'minutes', 'plan', 'note', 'source', 'created_at']];
  for (const p of plans) {
    const segs = await segments(q, p.id);
    planJson.push({
      id: p.id,
      kind: p.kind,
      name: p.name,
      activity: p.activity,
      status: p.status,
      start_date: p.start_date,
      ...(p.kind==='generic'?{generic_rules:await q.query('SELECT seq,field_id,value,from_date,to_date,period FROM generic_goal_segments WHERE plan_id=$1 ORDER BY seq',[p.id])}:{}),
      rules: segs.map((s) => ({ seq: s.seq, param: s.param, value: s.cleared ? null : s.value, ...(s.cleared ? { cleared: true } : {}), unit: s.param === 'budget_cents' ? 'CNY 分' : s.param === 'days_per_week' ? '天/周' : '分钟/天', from_period: s.fromPeriod, to_period: s.toPeriod })),
    });
    const recs = (await planRecords(q, p.id)).reverse();
    for (const r of recs) {
      if(r.kind==='generic')genericRecords.push(recordView(r));
      else if (r.kind === 'study') study.push([r.id, r.occurred_on, r.minutes, p.name, r.note, r.source, new Date(r.created_at).toISOString()]);
      else money.push([r.id, r.kind === 'expense' ? '支出' : '退款', r.occurred_on, (r.amount_cents! / 100).toFixed(2), 'CNY', r.category, r.note, r.refund_of ?? '', p.name, r.source, new Date(r.created_at).toISOString()]);
    }
  }
  const [g] = await q.query<{ total: number }>(`SELECT COALESCE(SUM(points), 0)::int AS total FROM growth_points WHERE user_id = $1`, [userId]);
  const items = await q.query(`SELECT slot, variant, unlocked_on, memory FROM house_items WHERE user_id = $1 ORDER BY unlocked_on, slot`, [userId]);
  const captions = await q.query(`SELECT week, caption FROM weekly_captions WHERE user_id = $1 ORDER BY week`, [userId]);
  const circle = await q.query(`SELECT c.name, m.nickname, m.eligible_from FROM circle_members m JOIN circles c ON c.id = m.circle_id WHERE m.user_id = $1`, [userId]);
  const creation=await exportCreationData(q,userId);
  const community=await exportCommunityData(q,userId);
  const feedback=await exportFeedbackData(q,userId);
  const definitions=await q.query<{definition:unknown}>(`SELECT DISTINCT v.template_id,v.version,v.definition FROM template_versions v JOIN records r ON r.template_id=v.template_id AND r.definition_version=v.version WHERE r.user_id=$1 AND (v.owner_user_id IS NULL OR v.owner_user_id=$1) ORDER BY v.template_id,v.version`,[userId]);
  return zipSync({
    'community.json':strToU8(JSON.stringify(community,null,2)),
    'feedback.json':strToU8(JSON.stringify(feedback,null,2)),
    'private-templates.json':strToU8(JSON.stringify({templates:creation.templates},null,2)),
    'creation-drafts.json':strToU8(JSON.stringify({drafts:creation.drafts,revisions:creation.revisions},null,2)),
    'generic-records.json':strToU8(JSON.stringify({records:genericRecords},null,2)),
    'templates.json': strToU8(JSON.stringify({ templates: await exportTemplatePlans(q, userId, shanghaiDate(new Date())),recordDefinitions:definitions.map(v=>v.definition) }, null, 2)),
    'growth.json': strToU8(JSON.stringify({ action_points: Number(g?.total ?? 0), house_items: items, weekly_captions: captions, circle: circle[0] ?? null }, null, 2)),
    'README.txt': strToU8(README),
    'plans.json': strToU8(JSON.stringify({ timezone: 'Asia/Shanghai', exported_at: new Date().toISOString(), plans: planJson }, null, 2)),
    'expenses_refunds.csv': strToU8(csv(money)),
    'study.csv': strToU8(csv(study)),
  });
}
