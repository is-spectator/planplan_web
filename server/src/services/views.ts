import { genericOverview } from './generic.js';
import type { GenericSummary,GenericValues } from '../templates/contracts.js';
import { fail } from './errors.js';
import type { Queryable } from '../db/db.js';
import { ledgerGroups, ledgerStatsFromGroups, studyDailyForPlans, lifecycleForPlans, type Lifecycle, type StudyDaily } from './view-aggregates.js';
import type { LedgerMonthStats } from '../domain/ledger.js';
import { isInterruptedWeek, studyWeekStats, type StudyWeekStats } from '../domain/study.js';
import { valueAt, type RuleSegment } from '../domain/rules.js';
import { monthOf, monthStart, monthEnd, prevWeek, weekEnd, weekOf, type BizDate, type MonthKey, type WeekKey } from '../domain/time.js';
import { dataVersion, getPlan, listPlans, planRecords, segments, segmentsForPlans, type PlanRow, type RecordRow } from './repo.js';

export interface PlanView {
  id: string;
  kind: 'ledger' | 'study' | 'generic';
  name: string;
  activity: string | null;
  status: 'active' | 'archived';
  startDate: string;
  hidden: string[];
  order: string[];
  lastActivityAt: string;
}

export interface RecordView {
  id: string;
  planId: string;
  kind: 'expense' | 'refund' | 'study' | 'generic';
  fields?:GenericValues;
  definitionVersion?:number;
  definitionTemplateId?:string;
  defaultedFields?:string[];
  amountCents: number | null;
  minutes: number | null;
  category: string | null;
  date: string;
  note: string;
  refundOf: string | null;
  refundedCents: number | null;
  source: 'chat' | 'form';
  sourceMessageId: string | null;
  version: number;
  deleted: boolean;
  createdAt: string;
}

export const LEDGER_COMPONENTS = ['summary', 'budget', 'categories', 'trend', 'records'] as const;
export const STUDY_COMPONENTS = ['goal', 'calendar', 'minutes', 'records'] as const;
/** 关键状态和记录入口始终保留，只有这些组件可以隐藏。 */
export const HIDEABLE = ['categories', 'trend', 'minutes'] as const;

/** 指标与周期区固定在顶部；可调整的内容去重后排列，遗漏项补齐。 */
export function componentOrder(kind: 'ledger' | 'study' | 'generic', supplied: unknown): string[] {
  if(kind==='generic') {const allowed=['summary','goal','records','categories','trend'];const selected=Array.isArray(supplied)?[...new Set(supplied.filter((c):c is string=>typeof c==='string'&&allowed.includes(c)))]:[];return selected.length?[...selected,...(selected.includes('records')?[]:['records'])]:['summary','goal','records'];}
  const pinned = kind === 'ledger' ? ['summary', 'budget'] : ['goal', 'calendar'];
  const movable = kind === 'ledger' ? ['categories', 'trend', 'records'] : ['minutes', 'records'];
  const order = Array.isArray(supplied) ? [...new Set(supplied.filter((c): c is string => typeof c === 'string' && movable.includes(c)))] : [];
  return [...pinned, ...order, ...movable.filter((c) => !order.includes(c))];
}

export function planView(p: PlanRow): PlanView {
  const order = componentOrder(p.kind, p.view_config.order);
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    activity: p.activity,
    status: p.status,
    startDate: p.start_date,
    hidden: (p.view_config.hidden ?? []).filter((h) => (HIDEABLE as readonly string[]).includes(h)),
    order,
    lastActivityAt: new Date(p.last_activity_at).toISOString(),
  };
}

export function recordView(r: RecordRow, refundedCents: number | null = null): RecordView {
  return {
    ...(r.kind==='generic'?{fields:r.fields??{},definitionVersion:r.definition_version!,definitionTemplateId:r.template_id!,...(r.defaulted_fields?.length?{defaultedFields:r.defaulted_fields}:{})}:{}),
    id: r.id,
    planId: r.plan_id,
    kind: r.kind,
    amountCents: r.amount_cents,
    minutes: r.minutes,
    category: r.category,
    date: r.occurred_on,
    note: r.note,
    refundOf: r.refund_of,
    refundedCents,
    source: r.source,
    sourceMessageId: r.source_message_id,
    version: r.version,
    deleted: r.deleted,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function ledgerStatsFor(q: Queryable, plan: PlanRow, month: MonthKey): Promise<LedgerMonthStats> {
  const groups = await ledgerGroups(q, plan, monthStart(month), monthEnd(month));
  const segs = await segments(q, plan.id);
  return ledgerStatsFromGroups(month, groups, valueAt(segs, 'budget_cents', month));
}

export interface LedgerView {
  plan: PlanView;
  month: MonthKey;
  stats: LedgerMonthStats;
  records: RecordView[];
  months: MonthKey[];
  dataVersion: number;
}

export async function ledgerView(q: Queryable, userId: string, planId: string, month: MonthKey, limit = 20, offset = 0): Promise<LedgerView> {
  const plan = await getPlan(q, userId, planId);
  if(plan.kind!=='ledger')fail('kind_mismatch','这个计划不支持记账。');
  // Preserve Array.slice's effective offset semantics now that pagination is SQL.
  const pageOffset = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(offset) || 0));
  const segs = await segments(q, plan.id);
  const stats = ledgerStatsFromGroups(month, await ledgerGroups(q, plan, monthStart(month), monthEnd(month)), valueAt(segs, 'budget_cents', month));
  const rows = await q.query<RecordRow & { refunded_cents: string }>(`
    SELECT r.*, COALESCE(refunds.total, 0) AS refunded_cents FROM records r
    LEFT JOIN (SELECT refund_of, SUM(amount_cents) AS total FROM records
      WHERE plan_id = $1 AND kind = 'refund' AND NOT deleted GROUP BY refund_of) refunds ON refunds.refund_of = r.id
    WHERE r.plan_id = $1 AND NOT r.deleted AND r.occurred_on BETWEEN $2 AND $3
    ORDER BY r.occurred_on DESC, r.created_at DESC, r.id DESC LIMIT $4 OFFSET $5`, [plan.id, monthStart(month), monthEnd(month), limit, pageOffset]);
  const periods = await q.query<{ month: string }>('SELECT DISTINCT left(occurred_on, 7) AS month FROM records WHERE plan_id = $1 AND NOT deleted', [plan.id]);
  const months = new Set<MonthKey>(periods.map((r) => r.month));
  for (const s of segs) if (s.param === 'budget_cents' && s.fromPeriod <= month) months.add(s.fromPeriod);
  months.add(month);
  return { plan: planView(plan), month, stats,
    records: rows.map((r) => recordView(r, r.kind === 'expense' ? Number(r.refunded_cents) : null)),
    months: [...months].sort().reverse(), dataVersion: await dataVersion(q, userId) };
}

function studyStatsFromData(plan: PlanRow, week: WeekKey, today: BizDate, daily: StudyDaily[], segs: RuleSegment[], life: Lifecycle[]): StudyWeekStats {
  return studyWeekStats({ week, planStart: plan.start_date, today, records: daily,
    daysPerWeek: valueAt(segs, 'days_per_week', week), minMinutes: valueAt(segs, 'min_minutes', week),
    interrupted: isInterruptedWeek(week, life) });
}

export async function studyStatsFor(q: Queryable, plan: PlanRow, week: WeekKey, today: BizDate): Promise<StudyWeekStats> {
  const daily = await studyDailyForPlans(q, [plan.id], week, weekEnd(week));
  const segs = await segments(q, plan.id);
  const life = await lifecycleForPlans(q, [plan.id]);
  return studyStatsFromData(plan, week, today, daily.get(plan.id) ?? [], segs, life.get(plan.id) ?? []);
}

export interface StudyView {
  plan: PlanView;
  week: WeekKey;
  today: BizDate;
  stats: StudyWeekStats;
  previous: StudyWeekStats | null;
  records: RecordView[];
  weeks: WeekKey[];
  totalRecords: number;
  dataVersion: number;
}

export async function studyView(q: Queryable, userId: string, planId: string, week: WeekKey, today: BizDate, page?: { limit: number; offset: number }): Promise<StudyView> {
  const plan = await getPlan(q, userId, planId);
  if(plan.kind!=='study')fail('kind_mismatch','这不是学习计划。');
  const segs = await segments(q, plan.id);
  const pw = prevWeek(week);
  const daily = (await studyDailyForPlans(q, [plan.id], pw, weekEnd(week))).get(plan.id) ?? [];
  const life = (await lifecycleForPlans(q, [plan.id])).get(plan.id) ?? [];
  const stats = studyStatsFromData(plan, week, today, daily, segs, life);
  const previous = pw >= weekOf(plan.start_date) || daily.some((r) => weekOf(r.date) === pw) ? studyStatsFromData(plan, pw, today, daily, segs, life) : null;
  const periods = await q.query<{ week: string }>(`SELECT DISTINCT to_char(date_trunc('week', occurred_on::date), 'YYYY-MM-DD') AS week FROM records WHERE plan_id = $1 AND NOT deleted`, [plan.id]);
  const weeks = new Set<WeekKey>(periods.map((r) => r.week));
  // Keep the current week reachable after navigating into an empty historical week.
  weeks.add(week); weeks.add(weekOf(today)); weeks.add(weekOf(plan.start_date));
  if (page && (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100 || !Number.isSafeInteger(page.offset) || page.offset < 0)) fail('invalid_input', '分页参数不正确。');
  const [count] = await q.query<{ total: number }>('SELECT count(*)::int total FROM records WHERE plan_id=$1 AND NOT deleted AND occurred_on BETWEEN $2 AND $3', [plan.id, week, weekEnd(week)]);
  const rows = page ? await q.query<RecordRow>('SELECT * FROM records WHERE plan_id=$1 AND NOT deleted AND occurred_on BETWEEN $2 AND $3 ORDER BY occurred_on DESC, created_at DESC, id DESC LIMIT $4 OFFSET $5', [plan.id, week, weekEnd(week), page.limit, page.offset]) : await planRecords(q, plan.id, { from: week, to: weekEnd(week) });
  return { plan: planView(plan), week, today, stats, previous, totalRecords: count!.total, records: rows.map((r) => recordView(r)),
    weeks: [...weeks].filter((w) => w <= weekOf(today) || w === week).sort().reverse(), dataVersion: await dataVersion(q, userId) };
}

export interface PlanCard {
  generic?:GenericSummary;
  plan: PlanView;
  ledger?: Pick<LedgerMonthStats, 'month' | 'spendCents' | 'refundCents' | 'netCents' | 'budgetCents' | 'remainingCents' | 'usagePct' | 'overCents'>;
  study?: {
    week: WeekKey;
    goalComplete: boolean;
    daysPerWeek: number | null;
    minMinutes: number | null;
    targetDays: number | null;
    metDays: number | null;
    recordDays: number;
    totalMinutes: number;
    todayMinutes: number;
    todayStatus: string;
    interrupted: boolean;
  };
}

function ledgerCard(plan: PlanRow, s: LedgerMonthStats): PlanCard {
  const { month, spendCents, refundCents, netCents, budgetCents, remainingCents, usagePct, overCents } = s;
  return { plan: planView(plan), ledger: { month, spendCents, refundCents, netCents, budgetCents, remainingCents, usagePct, overCents } };
}

function studyCard(plan: PlanRow, s: StudyWeekStats, today: BizDate): PlanCard {
  const td = s.days.find((d) => d.date === today);
  return { plan: planView(plan), study: {
    week: s.week, goalComplete: s.goalComplete, daysPerWeek: s.daysPerWeek, minMinutes: s.minMinutes,
    targetDays: s.targetDays, metDays: s.metDays, recordDays: s.recordDays, totalMinutes: s.totalMinutes,
    todayMinutes: td?.minutes ?? 0, todayStatus: td?.status ?? 'none', interrupted: s.interrupted,
  } };
}

export async function planCard(q: Queryable, plan: PlanRow, today: BizDate): Promise<PlanCard> {
  if(plan.kind==='generic')return {plan:planView(plan),generic:await genericOverview(q,plan.user_id,plan.id,today)};
  return plan.kind === 'ledger' ? ledgerCard(plan, await ledgerStatsFor(q, plan, monthOf(today))) : studyCard(plan, await studyStatsFor(q, plan, weekOf(today), today), today);
}

/** Batch related data once, preserving each plan's rules, lifecycle and caller order. */
export async function cardsForPlans(q: Queryable, plans: PlanRow[], today: BizDate): Promise<PlanCard[]> {
  if (!plans.length) return [];
  const segs = await segmentsForPlans(q, plans.map((p) => p.id));
  const studyIds = plans.filter((p) => p.kind === 'study').map((p) => p.id);
  const life = await lifecycleForPlans(q, studyIds);
  const daily = await studyDailyForPlans(q, studyIds, weekOf(today), weekEnd(weekOf(today)));
  const cards: PlanCard[] = [];
  for (const plan of plans) {
    const rules = segs.get(plan.id) ?? [];
    if (plan.kind === 'ledger') {
      const month = monthOf(today);
      cards.push(ledgerCard(plan, ledgerStatsFromGroups(month, await ledgerGroups(q, plan, monthStart(month), monthEnd(month)), valueAt(rules, 'budget_cents', month))));
    } else if(plan.kind==='generic')cards.push({plan:planView(plan),generic:await genericOverview(q,plan.user_id,plan.id,today)});
    else cards.push(studyCard(plan, studyStatsFromData(plan, weekOf(today), today, daily.get(plan.id) ?? [], rules, life.get(plan.id) ?? []), today));
  }
  return cards;
}

export async function planCards(q: Queryable, userId: string, today: BizDate, status: 'active' | 'archived') {
  const plans = (await listPlans(q, userId)).filter((p) => p.status === status);
  return { plans: await cardsForPlans(q, plans, today), dataVersion: await dataVersion(q, userId) };
}
