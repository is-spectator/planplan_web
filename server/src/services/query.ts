import { genericSummary } from './generic.js';
import type { GenericSummary } from '../templates/contracts.js';
import type { Queryable } from '../db/db.js';
import type { CategoryLine, Category } from '../domain/ledger.js';
import { addDays, isBizDate, monthEnd, monthOf, monthStart, prevMonth, prevWeek, weekEnd, weekOf, type BizDate } from '../domain/time.js';
import type { TurnComparison, TurnQuery } from '../ai/turn.js';
import { getLedger, listPlans, type PlanRow } from './repo.js';
import { planCard, cardsForPlans, ledgerStatsFor, planView, studyStatsFor, type PlanCard, type PlanView } from './views.js';
import { matchStudyByActivity } from './match.js';
import type { StudyWeekStats } from '../domain/study.js';
import { ledgerQueryTotals, studyRangeTotals } from './query-totals.js';
import { ledgerGroups, ledgerTotals } from './view-aggregates.js';

export interface ComparisonPeriod { from: BizDate; to: BizDate; label: string; value: number }

export type QueryCard =
  | {type:'query';kind:'generic_period';plan:PlanView;summary:GenericSummary}
  | {
      type: 'query';
      kind: 'ledger_month';
      plan: PlanView;
      month: string;
      from: BizDate;
      to: BizDate;
      spendCents: number;
      refundCents: number;
      netCents: number;
      budgetCents: number | null;
      remainingCents: number | null;
      usagePct: number | null;
      overCents: number | null;
      byCategory: CategoryLine[];
      focus: 'summary' | 'budget' | 'category';
      category: Category | null;
    }
  | { type: 'query'; kind: 'ledger_range'; plan: PlanView; from: BizDate; to: BizDate; spendCents: number; refundCents: number; netCents: number; byCategory: CategoryLine[]; category: Category | null; label: string; keywords?: string[]; count?: number }
  | { type: 'query'; kind: 'study_week'; plan: PlanView; stats: StudyWeekStats; label: string; today: BizDate }
  | { type: 'query'; kind: 'study_range'; plan: PlanView; from: BizDate; to: BizDate; label: string; totalMinutes: number; recordDays: number }
  | { type: 'query'; kind: 'comparison'; plan: PlanView; metric: TurnComparison['metric']; unit: 'CNY_cents' | 'minutes'; category: Category | null; keywords?: string[]; current: ComparisonPeriod; previous: ComparisonPeriod; delta: number; changePct: number | null }
  | { type: 'query'; kind: 'overview'; plans: PlanCard[]; label: string }
  | { type: 'query'; kind: 'none'; message: string };

function rangeFor(period: TurnQuery['period'], today: BizDate, from: string | null, to: string | null): { from: BizDate; to: BizDate; label: string; month?: string } | null {
  switch (period) {
    case 'today':
      return { from: today, to: today, label: '今天' };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1), label: '昨天' };
    case 'this_week':
      return { from: weekOf(today), to: today, label: '本周截至今天' };
    case 'last_week': {
      const w = prevWeek(weekOf(today));
      return { from: w, to: weekEnd(w), label: '上周' };
    }
    case 'last_month': {
      const m = prevMonth(monthOf(today));
      return { from: monthStart(m), to: monthEnd(m), label: '上月完整月份', month: m };
    }
    case 'recent_7_days':
      return { from: addDays(today, -6), to: today, label: '最近 7 天' };
    case 'custom':
      if (isBizDate(from) && isBizDate(to) && from <= to && from <= today) return { from, to: to > today ? today : to, label: to > today ? '指定区间截至今天' : '指定区间' };
      return null;
    default:
      return { from: monthStart(monthOf(today)), to: today, label: '本月截至今天', month: monthOf(today) };
  }
}

export async function runQuery(q: Queryable, userId: string, query: TurnQuery, today: BizDate, scope: PlanRow | null, text = '', excludedPlanIds: ReadonlySet<string> = new Set()): Promise<QueryCard> {
  const plans = (await listPlans(q, userId)).filter(plan => !excludedPlanIds.has(plan.id));
  const explicit = query.plan_id ? plans.find((p) => p.id === query.plan_id) ?? null : null;
  const none = (message: string): QueryCard => ({ type: 'query', kind: 'none', message });
  if (scope && excludedPlanIds.has(scope.id)) return none('这个计划需要在新版网页中查询，已有内容仍会保留。');
  if (query.plan_id && !explicit) return none('找不到指定的计划，请重新选择要查询的计划。');
  if (query.compare && (query.kind === 'overview' || query.kind === 'budget')) return none('周期对比支持同一计划的支出、退款、净支出或学习分钟数。请指定要比较的指标。');
  const r = rangeFor(query.period, today, query.from, query.to);
  if (!r) return none('日期范围无效，请提供起止日期，开始日期不能晚于今天。');
  const previous = query.compare ? rangeFor(query.compare.period, today, query.compare.from, query.compare.to) : null;
  if (query.compare && !previous) return none('用于对比的日期范围无效，请重新指定起止日期。');

  const compare = async (target: PlanRow): Promise<QueryCard> => {
    const metric = query.compare!.metric;
    if ((target.kind === 'study') !== (metric === 'minutes') || (target.kind === 'study' && query.category !== null)) return none('请用同一计划、同一指标进行比较：记账用支出、退款或净支出，学习用分钟数。');
    const value = async (range: { from: string; to: string }) => {
      if (metric === 'minutes') return (await studyRangeTotals(q, userId, target.id, range.from, range.to)).totalMinutes;
      const totals = await ledgerQueryTotals(q, userId, target.id, range.from, range.to, query.category, query.keywords ?? null);
      return metric === 'spend' ? totals.spendCents : metric === 'refund' ? totals.refundCents : totals.netCents;
    };
    // 顺序执行，兼容事务内的单连接 Queryable。
    const currentValue = await value(r), previousValue = await value(previous!);
    const delta = currentValue - previousValue;
    if (!Number.isSafeInteger(delta)) throw new Error('Query delta exceeds safe integer range');
    // 学习分钟不按备注筛选；只有真正参与过滤的关键词才写进卡片，避免把子集说成整本账。
    const keywords = metric !== 'minutes' && query.keywords?.length ? query.keywords : undefined;
    return { type: 'query', kind: 'comparison', plan: planView(target), metric, unit: metric === 'minutes' ? 'minutes' : 'CNY_cents', category: query.category, ...(keywords ? { keywords } : {}),
      current: { from: r.from, to: r.to, label: r.label, value: currentValue },
      previous: { from: previous!.from, to: previous!.to, label: previous!.label, value: previousValue }, delta,
      // 零和负基数不适合百分比增长语义，只展示真实差值。
      changePct: previousValue > 0 ? Math.round(delta / previousValue * 1000) / 10 : null };
  };

  if (query.kind === 'overview') {
    if (scope) return { type: 'query', kind: 'overview', plans: [await planCard(q, scope, today)], label: '当前计划' };
    const active = plans.filter((p) => p.status === 'active');
    if (!active.length) return { type: 'query', kind: 'none', message: '还没有进行中的计划。说出你想管理的事，就可以开始。' };
    const cards = await cardsForPlans(q, active, today);
    return { type: 'query', kind: 'overview', plans: cards, label: '进行中的计划' };
  }

  if(query.kind==='generic_summary'){
    if(explicit&&explicit.kind!=='generic')return none('指定的计划不支持通用统计。');
    if(query.compare)return none('这个模板暂不支持跨周期对比。');
    if(query.category!==null||query.keywords?.length)return none('这个模板目前只支持按日期范围统计，暂不支持分类或关键词筛选。请去掉筛选条件后再查询。');
    const candidates=plans.filter(p=>p.kind==='generic'&&p.status==='active');
    const target=explicit??(scope?.kind==='generic'?scope:null)??(candidates.length===1?candidates[0]:null);
    if(!target)return none('请指定要查询的计划。');
    if(addDays(r.from,365)<r.to)return none('一次最多查询 366 天。');
    return {type:'query',kind:'generic_period',plan:planView(target),summary:await genericSummary(q,userId,target.id,r.from,r.to)};
  }

  if (query.kind === 'study_progress') {
    if (explicit && explicit.kind !== 'study') return none('指定的计划不是学习计划，请重新选择。');
    const studies = plans.filter((p) => p.kind === 'study');
    const target =
      (explicit?.kind === 'study' ? explicit : null) ??
      (scope?.kind === 'study' ? scope : null) ??
      (studies.filter((p) => p.status === 'active').length === 1 ? studies.find((p) => p.status === 'active')! : null) ??
      (text ? matchStudyByActivity(studies, text) ?? null : null);
    if (!target) {
      if (query.compare) return none('要比较哪个学习计划？请说明计划名称。');
      const active = studies.filter((p) => p.status === 'active');
      if (!active.length) return { type: 'query', kind: 'none', message: '还没有阅读或学习计划。' };
      const cards = await cardsForPlans(q, active, today);
      return { type: 'query', kind: 'overview', plans: cards, label: '学习计划' };
    }
    if (query.compare) return compare(target);
    if (query.period !== 'this_week' && query.period !== 'last_week') {
      return { type: 'query', kind: 'study_range', plan: planView(target), from: r.from, to: r.to, label: r.label, ...await studyRangeTotals(q, userId, target.id, r.from, r.to) };
    }
    const week = query.period === 'last_week' ? prevWeek(weekOf(today)) : weekOf(today);
    return { type: 'query', kind: 'study_week', plan: planView(target), stats: await studyStatsFor(q, target, week, today), label: query.period === 'last_week' ? '上周' : '本周', today };
  }

  if (explicit && explicit.kind !== 'ledger') return none('指定的计划不支持记账，请重新选择。');
  const ledger = (explicit?.kind === 'ledger' ? explicit : null) ?? (await getLedger(q, userId));
  if (!ledger) return { type: 'query', kind: 'none', message: '还没有可用于记账的计划。说一句“帮我记账”就可以开始。' };
  if (query.compare) return compare(ledger);
  const category = query.kind === 'budget' ? null : query.category;
  // 具体消费（“加油花了多少”）按备注筛选，月份也走区间卡片：预算是整本账的，和单项消费无关。
  if (query.keywords?.length && query.kind !== 'budget') {
    const t = await ledgerQueryTotals(q, userId, ledger.id, r.from, r.to, category, query.keywords);
    return { type: 'query', kind: 'ledger_range', plan: planView(ledger), from: r.from, to: r.to, spendCents: t.spendCents, refundCents: t.refundCents, netCents: t.netCents, byCategory: [], category: null,
      label: `${r.label.replace('截至今天', '')} · ${query.keywords[0]}`, keywords: query.keywords, count: t.count };
  }
  if (r.month || query.kind === 'budget') {
    const month = r.month ?? monthOf(today);
    const s = await ledgerStatsFor(q, ledger, month);
    return {
      type: 'query',
      kind: 'ledger_month',
      plan: planView(ledger),
      month,
      from: monthStart(month),
      to: month === monthOf(today) ? today : monthEnd(month),
      spendCents: s.spendCents,
      refundCents: s.refundCents,
      netCents: s.netCents,
      budgetCents: s.budgetCents,
      remainingCents: s.remainingCents,
      usagePct: s.usagePct,
      overCents: s.overCents,
      byCategory: s.byCategory,
      focus: query.kind === 'budget' ? 'budget' : category !== null || query.kind === 'ledger_category' ? 'category' : 'summary',
      category,
    };
  }
  const t = ledgerTotals(await ledgerGroups(q, ledger, r.from, r.to));
  const byCategory = t.byCategory;
  return { type: 'query', kind: 'ledger_range', plan: planView(ledger), from: r.from, to: r.to, spendCents: t.spendCents, refundCents: t.refundCents, netCents: t.netCents, byCategory, category, label: r.label };
}
