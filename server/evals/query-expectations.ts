import type { Card } from '../src/services/chat.js';
import type { Fixture } from './fixtures.js';

// 独立人工可审阅的 oracle；不调用生产统计/查询函数生成期望。
// $ledger/$read/$eng 只替换每次 fixture 的随机 ID，金额和日期均为固定事实。
type Pattern = string | number | boolean | null | Pattern[] | { [key: string]: Pattern };
const categories = [
  { category: '购物', spendCents: 19900, refundCents: 0, netCents: 19900 },
  { category: '餐饮', spendCents: 14800, refundCents: 0, netCents: 14800 },
  { category: '交通', spendCents: 600, refundCents: 0, netCents: 600 },
];
const month = (category: string | null = null): Pattern => ({
  kind: 'ledger_month', plan: { id: '$ledger' }, month: '2026-10', from: '2026-10-01', to: '2026-10-26',
  spendCents: 35300, refundCents: 0, netCents: 35300, budgetCents: 300000, remainingCents: 264700,
  usagePct: 12, overCents: null, category, byCategory: categories,
  ...(category === null ? {} : { focus: 'category' }),
});
const previousMonth: Pattern = { kind: 'ledger_month', plan: { id: '$ledger' }, month: '2026-09', from: '2026-09-01', to: '2026-09-30', spendCents: 0, refundCents: 0, netCents: 0, budgetCents: null, remainingCents: null, usagePct: null, byCategory: [], category: null };
const range = (from: string, to: string, cents: number, lines: Pattern[], category: string | null = null): Pattern => ({ kind: 'ledger_range', plan: { id: '$ledger' }, from, to, spendCents: cents, refundCents: 0, netCents: cents, byCategory: lines, category });
const item = (from: string, to: string, cents: number, count: number): Pattern => ({ kind: 'ledger_range', plan: { id: '$ledger' }, from, to, spendCents: cents, refundCents: 0, netCents: cents, count });
const meal = (cents: number): Pattern => ({ category: '餐饮', spendCents: cents, refundCents: 0, netCents: cents });
const today = range('2026-10-26', '2026-10-26', 2000, [meal(2000)]);
const week = (ref = '$read', previous = false): Pattern => ({ kind: 'study_week', plan: { id: ref }, today: '2026-10-26', stats: { week: previous ? '2026-10-19' : '2026-10-26', daysPerWeek: ref === '$read' ? 5 : 3, minMinutes: ref === '$read' ? 20 : null, targetDays: ref === '$read' ? 5 : null, metDays: ref === '$read' ? (previous ? 0 : 1) : null, recordDays: previous || ref === '$eng' ? 0 : 1, totalMinutes: previous || ref === '$eng' ? 0 : 45, interrupted: false } });
const readOverview: Pattern = { plan: { id: '$read' }, study: { week: '2026-10-26', recordDays: 1, totalMinutes: 45, metDays: 1, targetDays: 5, todayMinutes: 45 } };
const overview: Pattern = { kind: 'overview', plans: [
  { plan: { id: '$ledger' }, ledger: { month: '2026-10', netCents: 35300, budgetCents: 300000, remainingCents: 264700 } },
  readOverview,
  { plan: { id: '$eng' }, study: { week: '2026-10-26', recordDays: 0, totalMinutes: 0, metDays: null, targetDays: null, todayMinutes: 0 } },
] };
const comparison = (metric: string, current: number, previous: number, delta: number, changePct: number | null, category: string | null = null, previousEnd = '2026-09-30'): Pattern => ({
  kind: 'comparison', plan: { id: metric === 'minutes' ? '$read' : '$ledger' }, metric, unit: metric === 'minutes' ? 'minutes' : 'CNY_cents', category,
  current: { from: '2026-10-01', to: '2026-10-26', value: current }, previous: { from: '2026-09-01', to: previousEnd, value: previous }, delta, changePct,
});

export const QUERY_EXPECTATIONS: Record<string, Pattern[]> = {
  Q001: [month()], Q002: [month()], Q003: [month()], Q004: [previousMonth], Q005: [today],
  Q006: [range('2026-10-25', '2026-10-25', 0, [])],
  Q007: [range('2026-10-20', '2026-10-26', 15400, [meal(14800), categories[2]!])],
  Q008: [today], Q009: [month('餐饮')], Q010: [month('交通')], Q011: [month('购物')], Q012: [month()], Q013: [month()],
  Q014: [week()], Q015: [week()], Q016: [week('$read', true)], Q017: [week('$eng')],
  // 单日查询不能因当日碰巧等于本周数值就通过。
  Q018: [{ kind: 'study_range', plan: { id: '$read' }, from: '2026-10-26', to: '2026-10-26', totalMinutes: 45, recordDays: 1 }],
  Q019: [overview], Q020: [overview], Q021: [overview],
  Q022: [range('2026-10-20', '2026-10-20', 12800, [meal(12800)])],
  Q023: [month()], Q024: [month()], Q025: [month('餐饮')], Q026: [month('娱乐')],
  Q027: [range('2026-10-19', '2026-10-25', 13400, [meal(12800), categories[2]!])],
  Q028: [{ kind: 'study_range', plan: { id: '$read' }, from: '2026-10-25', to: '2026-10-25', totalMinutes: 0, recordDays: 0 }],
  Q029: [week()], Q030: [week('$eng')], Q031: [week(), { kind: 'overview', plans: [readOverview] }],
  Q032: [month()], Q033: [month()], Q034: [month()],
  Q035: [range('2026-10-26', '2026-10-26', 2000, [meal(2000)], '餐饮')],
  Q036: [week()], Q037: [previousMonth], Q038: [month()], Q039: [month()],
  Q040: [week(), { kind: 'overview', plans: [readOverview] }],
  Q041: [comparison('spend', 35300, 10000, 25300, 253)],
  Q042: [comparison('net', 32300, 8000, 24300, 303.8)],
  Q043: [comparison('refund', 3000, 2000, 1000, 50)],
  Q044: [comparison('minutes', 45, 60, -15, -25)],
  Q045: [comparison('net', 16900, 8000, 8900, 111.3, '购物')],
  Q046: [comparison('minutes', 45, 60, -15, -25, null, '2026-09-26')],
  Q047: [{ kind: 'comparison', plan: { id: '$ledger' }, metric: 'spend', unit: 'CNY_cents', category: null,
    current: { from: '2026-10-26', to: '2026-10-26', value: 2000 }, previous: { from: '2026-10-25', to: '2026-10-25', value: 0 }, delta: 2000, changePct: null }],
  Q048: [{ kind: 'study_range', plan: { id: '$read' }, from: '2026-10-20', to: '2026-10-26', totalMinutes: 45, recordDays: 1 }],
  Q049: [{ kind: 'study_range', plan: { id: '$read' }, from: '2026-10-01', to: '2026-10-26', totalMinutes: 45, recordDays: 1 }],
  Q050: [{ kind: 'study_range', plan: { id: '$read' }, from: '2026-10-24', to: '2026-10-26', totalMinutes: 45, recordDays: 1 }],
  // 具体消费按备注统计；多轮样例的后续轮次用「编号.轮次」。
  K001: [item('2026-10-26', '2026-10-26', 2000, 1)],
  K002: [month()],
  'K002.1': [item('2026-10-01', '2026-10-26', 600, 1)],
  'K002.2': [item('2026-10-19', '2026-10-25', 600, 1)],
  K003: [item('2026-10-01', '2026-10-26', 19900, 1)],
  K004: [item('2026-10-26', '2026-10-26', 0, 0)],
  K005: [item('2026-10-26', '2026-10-26', 0, 0)],
  'K005.1': [item('2026-10-26', '2026-10-26', 0, 0)],
  'K005.2': [item('2026-10-26', '2026-10-26', 0, 0)],
};

function matches(actual: unknown, expected: Pattern, fx: Fixture): boolean {
  if (typeof expected === 'string' && expected.startsWith('$')) return actual === fx.plans[expected.slice(1) as keyof Fixture['plans']];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const remaining = [...actual];
    return expected.every((want) => { const i = remaining.findIndex((got) => matches(got, want, fx)); if (i < 0) return false; remaining.splice(i, 1); return true; });
  }
  if (expected !== null && typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value, fx));
  }
  return actual === expected;
}

export function judgeQuery(id: string, fx: Fixture, cards: Card[]): { pass: boolean; reason: string } {
  const expected = QUERY_EXPECTATIONS[id];
  if (!expected) return { pass: false, reason: `查询 ${id} 缺少独立数值/周期期望，不可计为通过` };
  const queries = cards.filter((c) => c.type === 'query');
  if (queries.length !== 1) return { pass: false, reason: '必须返回恰好一张查询卡片' };
  const pass = expected.some((want) => matches(queries[0], want, fx));
  return { pass, reason: pass ? '' : `查询 ${id} 的数值、周期、分类或计划归属不符合固定场景` };
}
