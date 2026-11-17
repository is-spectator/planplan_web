import type { Queryable } from '../db/db.js';
import { CATEGORIES, type Category, type CategoryLine, type LedgerMonthStats } from '../domain/ledger.js';
import { monthDays, type MonthKey } from '../domain/time.js';
import { percent } from '../domain/money.js';
import type { PlanRow } from './repo.js';

const integer = (value: number | string) => {
  const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('Aggregate exceeds safe integer range'); return n;
};
export interface LedgerGroup { date: string; category: Category; spendCents: number; refundCents: number; expenseCount: number; refundCount: number }

/** Keep integer SUMs in PostgreSQL; cross-month refunds inherit the original category. */
export const LEDGER_GROUP_SQL = `
    SELECT r.occurred_on AS date,
      COALESCE(CASE WHEN r.kind = 'refund' THEN original.category ELSE r.category END, '其他') AS category,
      COALESCE(SUM(r.amount_cents) FILTER (WHERE r.kind = 'expense'), 0) AS spend,
      COALESCE(SUM(r.amount_cents) FILTER (WHERE r.kind = 'refund'), 0) AS refund,
      COUNT(*) FILTER (WHERE r.kind = 'expense') AS expenses, COUNT(*) FILTER (WHERE r.kind = 'refund') AS refunds
    FROM records r LEFT JOIN records original ON original.id = r.refund_of AND original.user_id = r.user_id
      AND original.plan_id = r.plan_id AND NOT original.deleted
    WHERE r.plan_id = $1 AND r.user_id = $2 AND NOT r.deleted AND r.kind IN ('expense', 'refund')
      AND r.occurred_on BETWEEN $3 AND $4
    GROUP BY r.occurred_on, COALESCE(CASE WHEN r.kind = 'refund' THEN original.category ELSE r.category END, '其他')`;

export async function ledgerGroups(q: Queryable, plan: PlanRow, from: string, to: string): Promise<LedgerGroup[]> {
  const rows = await q.query<{ date: string; category: Category; spend: string; refund: string; expenses: string; refunds: string }>(LEDGER_GROUP_SQL, [plan.id, plan.user_id, from, to]);
  return rows.map((r) => ({ date: r.date, category: r.category, spendCents: integer(r.spend), refundCents: integer(r.refund), expenseCount: integer(r.expenses), refundCount: integer(r.refunds) }));
}

export function ledgerTotals(groups: LedgerGroup[]) {
  const lines = new Map<Category, CategoryLine>();
  let spendCents = 0, refundCents = 0, expenseCount = 0, refundCount = 0;
  for (const g of groups) {
    spendCents += g.spendCents; refundCents += g.refundCents; expenseCount += g.expenseCount; refundCount += g.refundCount;
    const line = lines.get(g.category) ?? { category: g.category, spendCents: 0, refundCents: 0, netCents: 0 };
    line.spendCents += g.spendCents; line.refundCents += g.refundCents; line.netCents = line.spendCents - line.refundCents;
    lines.set(g.category, line);
  }
  for (const n of [spendCents, refundCents, spendCents - refundCents]) integer(n);
  return { spendCents, refundCents, netCents: spendCents - refundCents, expenseCount, refundCount,
    byCategory: [...lines.values()].sort((a, b) => b.netCents - a.netCents || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category)) };
}

export function ledgerStatsFromGroups(month: MonthKey, groups: LedgerGroup[], budgetCents: number | null): LedgerMonthStats {
  const totals = ledgerTotals(groups), days = new Map<string, number>();
  for (const g of groups) days.set(g.date, (days.get(g.date) ?? 0) + g.spendCents - g.refundCents);
  const remainingCents = budgetCents === null ? null : budgetCents - totals.netCents;
  return { month, ...totals, budgetCents, remainingCents, usagePct: budgetCents === null ? null : percent(totals.netCents, budgetCents),
    overCents: remainingCents !== null && remainingCents < 0 ? -remainingCents : null,
    daily: monthDays(month).map((date) => ({ date, netCents: days.get(date) ?? 0 })) };
}

export interface StudyDaily { date: string; minutes: number; sessions: number }
export async function studyDailyForPlans(q: Queryable, planIds: string[], from: string, to: string): Promise<Map<string, StudyDaily[]>> {
  const grouped = new Map<string, StudyDaily[]>();
  if (!planIds.length) return grouped;
  const rows = await q.query<{ plan_id: string; date: string; minutes: string; sessions: string }>(`
    SELECT plan_id, occurred_on AS date, COALESCE(SUM(minutes), 0) AS minutes, COUNT(*) AS sessions FROM records
    WHERE plan_id = ANY($1::uuid[]) AND NOT deleted AND kind = 'study' AND occurred_on BETWEEN $2 AND $3
    GROUP BY plan_id, occurred_on`, [planIds, from, to]);
  for (const r of rows) {
    const list = grouped.get(r.plan_id) ?? []; list.push({ date: r.date, minutes: integer(r.minutes), sessions: integer(r.sessions) }); grouped.set(r.plan_id, list);
  }
  return grouped;
}

export type Lifecycle = { event: 'archived' | 'restored'; on_date: string };
export async function lifecycleForPlans(q: Queryable, planIds: string[]): Promise<Map<string, Lifecycle[]>> {
  const grouped = new Map<string, Lifecycle[]>();
  if (!planIds.length) return grouped;
  const rows = await q.query<Lifecycle & { plan_id: string }>('SELECT plan_id, event, on_date FROM plan_lifecycle WHERE plan_id = ANY($1::uuid[]) ORDER BY seq', [planIds]);
  for (const r of rows) { const list = grouped.get(r.plan_id) ?? []; list.push({ event: r.event, on_date: r.on_date }); grouped.set(r.plan_id, list); }
  return grouped;
}
