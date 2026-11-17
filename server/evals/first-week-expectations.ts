import type { Card } from '../src/services/chat.js';
import type { Fixture } from './fixtures.js';

/** 人工写定日期/数值，不复用首周计算和目标规则实现；样例仍待产品与测试审定。 */
type Expected =
  | { kind: 'choice'; start: string; end: string; available: number; next: string }
  | { kind: 'plan'; start: string; first: number; days: number; from: string; startsOn: string | null }
  | { kind: 'goal'; current: number; next: number }
  | { kind: 'cancel' };
const saturdayChoice: Expected = { kind: 'choice', start: '2026-10-31', end: '2026-11-01', available: 2, next: '2026-11-02' };
const saturdayPlan: Expected = { kind: 'plan', start: '2026-10-31', first: 2, days: 4, from: '2026-10-26', startsOn: null };
export const FIRST_WEEK_EXPECTATIONS: Record<string, Expected[]> = {
  W001: [saturdayPlan],
  W002: [saturdayChoice, saturdayPlan],
  W003: [saturdayChoice, { kind: 'plan', start: '2026-11-02', first: 4, days: 4, from: '2026-11-02', startsOn: '2026-11-02' }],
  W004: [{ kind: 'choice', start: '2026-11-01', end: '2026-11-01', available: 1, next: '2026-11-02' }, { kind: 'cancel' }],
  W005: [{ kind: 'plan', start: '2026-10-31', first: 2, days: 2, from: '2026-10-26', startsOn: null }],
  W006: [saturdayChoice, { kind: 'goal', current: 2, next: 3 }],
};

export async function judgeFirstWeek(id: string, step: number, fx: Fixture, cards: Card[]): Promise<{ pass: boolean; reason: string }> {
  const want = FIRST_WEEK_EXPECTATIONS[id]?.[step];
  if (!want) return { pass: false, reason: '首周样例缺少独立期望' };
  const fail = (reason: string) => ({ pass: false, reason });
  if (want.kind === 'choice') {
    const choices = cards.filter((c) => c.type === 'clarify' && c.status === 'open');
    if (choices.length !== 1 || choices[0]!.type !== 'clarify') return fail('需要恰好一张首周选择卡');
    const c = choices[0]!;
    if (![want.start, want.end, want.next, `可用 ${want.available} 天`].every((s) => c.question.includes(s))) return fail('可用日期或天数不符');
    if (JSON.stringify(c.options.map((o) => o.label)) !== JSON.stringify([`本周按 ${want.available} 天`, '从下周开始', '取消'])) return fail('缺少明确的调整/下周/取消选项');
  } else if (want.kind === 'plan') {
    const plans = await fx.db.query<{ id: string; kind: string; start_date: string }>('SELECT id, kind, start_date FROM plans WHERE user_id=$1', [fx.userId]);
    if (plans.length !== 1 || plans[0]!.kind !== 'study' || plans[0]!.start_date !== want.start) return fail('实际计划开始日期或数量不符');
    const items = cards.flatMap((c) => c.type === 'receipt' ? c.items : []);
    if (items.length !== 1 || items[0]!.type !== 'plan_created') return fail('应只有一项建立计划回执');
    const it = items[0]!;
    if (it.firstWeekTarget !== want.first || it.daysPerWeek !== want.days || it.minMinutes !== 20 || (it.goalStartsOn ?? null) !== want.startsOn) return fail('回执目标或生效时间不符');
    const segments = await fx.db.query<{ param: string; value: number; from_period: string; to_period: string | null }>('SELECT param,value,from_period,to_period FROM goal_segments WHERE plan_id=$1 AND NOT revoked ORDER BY param', [plans[0]!.id]);
    if (JSON.stringify(segments) !== JSON.stringify([{ param: 'days_per_week', value: want.days, from_period: want.from, to_period: null }, { param: 'min_minutes', value: 20, from_period: want.from, to_period: null }])) return fail('数据库规则段与独立期望不符');
  } else if (want.kind === 'goal') {
    for (const [week, target] of [['2026-10-26', want.current], ['2026-11-02', want.next]] as const) {
      const rows = await fx.db.query<{ value: number }>('SELECT value FROM goal_segments WHERE plan_id=$1 AND param=\'days_per_week\' AND NOT revoked AND from_period<=$2 AND (to_period IS NULL OR to_period>=$2) ORDER BY seq DESC LIMIT 1', [fx.plans.read, week]);
      if (rows[0]?.value !== target) return fail(`周期 ${week} 规则不符`);
    }
  } else {
    const [row] = await fx.db.query<{ n: number }>("SELECT count(*)::int n FROM pending_actions WHERE user_id=$1 AND status='open'", [fx.userId]);
    if (row!.n !== 0) return fail('取消后仍有待确认内容');
  }
  return { pass: true, reason: '' };
}
