import { type BizDate, type MonthKey, monthDays, monthOf } from './time.js';
import { percent } from './money.js';

export const CATEGORIES = ['餐饮', '交通', '购物', '居住', '学习', '娱乐', '其他'] as const;
export type Category = (typeof CATEGORIES)[number];
export function isCategory(s: unknown): s is Category {
  return typeof s === 'string' && (CATEGORIES as readonly string[]).includes(s);
}

export interface ExpenseFact {
  id: string;
  amountCents: number;
  date: BizDate;
  category: Category;
}
export interface RefundFact {
  id: string;
  amountCents: number;
  date: BizDate;
  refundOf: string;
}

export interface CategoryLine {
  category: Category;
  spendCents: number;
  refundCents: number;
  netCents: number;
}

export interface LedgerMonthStats {
  month: MonthKey;
  spendCents: number;
  refundCents: number;
  netCents: number;
  budgetCents: number | null;
  remainingCents: number | null;
  usagePct: number | null;
  overCents: number | null;
  expenseCount: number;
  refundCount: number;
  byCategory: CategoryLine[];
  daily: { date: BizDate; netCents: number }[];
}

/**
 * 月度统计。退款计入实际发生的月份，分类跟随原支出。
 * allExpenses 用于查找跨月退款的原支出分类。
 */
export function ledgerMonthStats(
  month: MonthKey,
  allExpenses: ExpenseFact[],
  allRefunds: RefundFact[],
  budgetCents: number | null,
): LedgerMonthStats {
  const byId = new Map(allExpenses.map((e) => [e.id, e]));
  const expenses = allExpenses.filter((e) => monthOf(e.date) === month);
  const refunds = allRefunds.filter((r) => monthOf(r.date) === month);
  const spendCents = expenses.reduce((s, e) => s + e.amountCents, 0);
  const refundCents = refunds.reduce((s, r) => s + r.amountCents, 0);
  const netCents = spendCents - refundCents;

  const cat = new Map<Category, CategoryLine>();
  const line = (c: Category) => {
    let l = cat.get(c);
    if (!l) cat.set(c, (l = { category: c, spendCents: 0, refundCents: 0, netCents: 0 }));
    return l;
  };
  for (const e of expenses) line(e.category).spendCents += e.amountCents;
  for (const r of refunds) {
    const orig = byId.get(r.refundOf);
    line(orig ? orig.category : '其他').refundCents += r.amountCents;
  }
  for (const l of cat.values()) l.netCents = l.spendCents - l.refundCents;
  const byCategory = [...cat.values()].sort((a, b) => b.netCents - a.netCents || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));

  const dayNet = new Map<BizDate, number>();
  for (const e of expenses) dayNet.set(e.date, (dayNet.get(e.date) ?? 0) + e.amountCents);
  for (const r of refunds) dayNet.set(r.date, (dayNet.get(r.date) ?? 0) - r.amountCents);
  const daily = monthDays(month).map((date) => ({ date, netCents: dayNet.get(date) ?? 0 }));

  const remainingCents = budgetCents === null ? null : budgetCents - netCents;
  return {
    month,
    spendCents,
    refundCents,
    netCents,
    budgetCents,
    remainingCents,
    usagePct: budgetCents === null ? null : percent(netCents, budgetCents),
    overCents: remainingCents !== null && remainingCents < 0 ? -remainingCents : null,
    expenseCount: expenses.length,
    refundCount: refunds.length,
    byCategory,
    daily,
  };
}

/** 任意日期范围的统计（不折算月预算）。 */
export function ledgerRangeTotals(from: BizDate, to: BizDate, expenses: ExpenseFact[], refunds: RefundFact[]) {
  const inR = (d: BizDate) => d >= from && d <= to;
  const spendCents = expenses.filter((e) => inR(e.date)).reduce((s, e) => s + e.amountCents, 0);
  const refundCents = refunds.filter((r) => inR(r.date)).reduce((s, r) => s + r.amountCents, 0);
  return { from, to, spendCents, refundCents, netCents: spendCents - refundCents };
}

export type RefundProblem =
  | { code: 'refund_before_expense'; refundId?: string }
  | { code: 'refund_exceeds_expense'; totalRefundCents: number; expenseCents: number };

/** 校验一笔支出与它全部有效退款的关系。新增、修改、撤销后都要整组重新校验。 */
export function validateRefundGroup(
  expense: { amountCents: number; date: BizDate },
  refunds: { id?: string; amountCents: number; date: BizDate }[],
): RefundProblem[] {
  const problems: RefundProblem[] = [];
  for (const r of refunds) if (r.date < expense.date) problems.push({ code: 'refund_before_expense', refundId: r.id });
  const total = refunds.reduce((s, r) => s + r.amountCents, 0);
  if (total > expense.amountCents) problems.push({ code: 'refund_exceeds_expense', totalRefundCents: total, expenseCents: expense.amountCents });
  return problems;
}
