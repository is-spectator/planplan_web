import { describe, expect, it } from 'vitest';
import { addDays, resolveDateExpr, shanghaiDate, weekOf, isoWeekday, monthEnd } from '../src/domain/time.js';
import { formatYuan, parseYuanToCents } from '../src/domain/money.js';
import { ledgerMonthStats, validateRefundGroup, type ExpenseFact, type RefundFact } from '../src/domain/ledger.js';
import { studyWeekStats, weekTargetDays } from '../src/domain/study.js';
import { planRuleChange, valueAt, type RuleSegment } from '../src/domain/rules.js';

const exp = (id: string, yuan: number, date: string, category: ExpenseFact['category'] = '餐饮'): ExpenseFact => ({ id, amountCents: yuan * 100, date, category });
const ref = (id: string, yuan: number, date: string, refundOf: string): RefundFact => ({ id, amountCents: yuan * 100, date, refundOf });

describe('time', () => {
  it('上海日期与周一为周首', () => {
    expect(shanghaiDate(new Date('2026-10-31T16:30:00Z'))).toBe('2026-11-01');
    expect(isoWeekday('2026-10-26')).toBe(1);
    expect(weekOf('2026-11-01')).toBe('2026-10-26');
    expect(monthEnd('2026-02')).toBe('2026-02-28');
  });
  it('AC11 11月1日说“昨天”是10月31日', () => {
    expect(resolveDateExpr({ kind: 'yesterday' }, new Date('2026-11-01T04:00:00+08:00'))).toBe('2026-10-31');
  });
  it('AC12 “今天”按输入时刻而不是上传时刻', () => {
    const typedAt = new Date('2026-10-31T23:50:00+08:00');
    expect(resolveDateExpr({ kind: 'today' }, typedAt)).toBe('2026-10-31');
  });
});

describe('money', () => {
  it('格式化与解析', () => {
    expect(formatYuan(129000)).toBe('¥1,290');
    expect(formatYuan(-5000)).toBe('−¥50');
    expect(formatYuan(2550)).toBe('¥25.50');
    expect(parseYuanToCents('20块')).toBe(2000);
    expect(parseYuanToCents('12.5')).toBe(1250);
    expect(parseYuanToCents('1.234')).toBeNull();
  });
});

describe('ledger', () => {
  const base = [exp('a', 1270, '2026-10-05')];
  it('AC03 午餐20元后净支出1290、剩余1710、使用43%', () => {
    const s = ledgerMonthStats('2026-10', [...base, exp('l', 20, '2026-10-26')], [], 300000);
    expect([s.netCents, s.remainingCents, s.usagePct]).toEqual([129000, 171000, 43]);
  });
  it('AC04 改为25元后净支出1295、剩余1705', () => {
    const s = ledgerMonthStats('2026-10', [...base, exp('l', 25, '2026-10-26')], [], 300000);
    expect([s.netCents, s.remainingCents]).toEqual([129500, 170500]);
  });
  it('AC06 超预算显示负剩余与超出金额，使用率不截断', () => {
    const s = ledgerMonthStats('2026-10', [exp('x', 120, '2026-10-02')], [], 10000);
    expect([s.remainingCents, s.overCents, s.usagePct]).toEqual([-2000, 2000, 120]);
  });
  it('AC07 跨月退款计入退款月，净支出可为负', () => {
    const e = [exp('o', 200, '2026-10-30', '购物')];
    const r = [ref('r', 50, '2026-11-02', 'o')];
    expect(ledgerMonthStats('2026-10', e, r, null).netCents).toBe(20000);
    const nov = ledgerMonthStats('2026-11', e, r, 100000);
    expect([nov.netCents, nov.remainingCents]).toEqual([-5000, 105000]);
    expect(nov.byCategory[0]).toMatchObject({ category: '购物', spendCents: 0, refundCents: 5000, netCents: -5000 });
  });
  it('AC08 累计退款超过原金额被拒绝', () => {
    const p = validateRefundGroup({ amountCents: 20000, date: '2026-10-30' }, [
      { amountCents: 5000, date: '2026-11-02' },
      { amountCents: 16000, date: '2026-11-03' },
    ]);
    expect(p.map((x) => x.code)).toEqual(['refund_exceeds_expense']);
  });
  it('AC09 原支出改到低于已退款金额被拒绝', () => {
    expect(validateRefundGroup({ amountCents: 4000, date: '2026-10-30' }, [{ amountCents: 5000, date: '2026-11-02' }]).length).toBe(1);
  });
  it('AC43 原支出日期改到退款之后被拒绝', () => {
    const p = validateRefundGroup({ amountCents: 20000, date: '2026-11-05' }, [{ amountCents: 5000, date: '2026-11-02' }]);
    expect(p[0]?.code).toBe('refund_before_expense');
  });
  it('设计稿的统一演示数据能被算出来', () => {
    const e = [exp('1', 620, '2026-10-03', '餐饮'), exp('2', 380, '2026-10-18', '购物'), exp('3', 210, '2026-10-08', '交通'), exp('4', 130, '2026-10-12', '其他')];
    const s = ledgerMonthStats('2026-10', e, [ref('r', 50, '2026-10-24', '2')], 300000);
    expect([s.spendCents, s.refundCents, s.netCents, s.remainingCents, s.usagePct]).toEqual([134000, 5000, 129000, 171000, 43]);
    expect(s.byCategory.map((c) => [c.category, c.netCents])).toEqual([['餐饮', 62000], ['购物', 33000], ['交通', 21000], ['其他', 13000]]);
    expect(s.daily.find((d) => d.date === '2026-10-24')?.netCents).toBe(-5000);
  });
});

describe('study', () => {
  const W = '2026-10-26';
  const run = (records: { date: string; minutes: number }[], n: number | null, m: number | null, today = '2026-11-01', start = '2026-10-01') =>
    studyWeekStats({ week: W, planStart: start, today, records, daysPerWeek: n, minMinutes: m, interrupted: false });

  it('AC18 同日10+10+30只算一个达标日', () => {
    const s = run([{ date: W, minutes: 10 }, { date: W, minutes: 10 }, { date: W, minutes: 30 }], 5, 20);
    expect([s.metDays, s.days[0]?.minutes, s.days[0]?.sessions]).toEqual([1, 50, 3]);
  });
  it('AC19 删除一条后低于门槛撤回达标', () => {
    expect(run([{ date: W, minutes: 10 }], 5, 20).days[0]?.status).toBe('below');
  });
  it('AC20 目标4天完成6天显示超额2天', () => {
    const rec = [0, 1, 2, 3, 4, 5].map((i) => ({ date: addDays(W, i), minutes: 30 }));
    const s = run(rec, 4, 20);
    expect([s.metDays, s.targetDays, s.exceededDays]).toEqual([6, 4, 2]);
  });
  it('AC21 目标不完整时只统计记录天数，不算达标', () => {
    const s = run([{ date: W, minutes: 30 }], 5, null);
    expect([s.goalComplete, s.metDays, s.recordDays, s.days[0]?.status]).toEqual([false, null, 1, 'recorded']);
  });
  it('AC24 周六创建每周4天，首周目标2天，下周4天', () => {
    expect(weekTargetDays('2026-10-31', '2026-10-26', 4)).toBe(2);
    expect(weekTargetDays('2026-10-31', '2026-11-02', 4)).toBe(4);
  });
  it('未来日期显示为还没到', () => {
    const s = run([{ date: W, minutes: 45 }], 5, 20, W);
    expect(s.days.map((d) => d.status)).toEqual(['met', 'future', 'future', 'future', 'future', 'future', 'future']);
  });
});

describe('rules', () => {
  const seg = (param: RuleSegment['param'], value: number, fromPeriod: string, toPeriod: string | null, seq: number): RuleSegment => ({ param, value, fromPeriod, toPeriod, seq });

  it('AC25 本周目标4改5，上周保留4', () => {
    const segs = [seg('days_per_week', 4, '2026-10-12', null, 1)];
    const ch = planRuleChange(segs, 'days_per_week', 5, 'current_and_future', '2026-10-26', '2026-11-02');
    const all = [...segs, { ...ch.segment, seq: 2 }];
    expect(valueAt(all, 'days_per_week', '2026-10-19')).toBe(4);
    expect(valueAt(all, 'days_per_week', '2026-10-26')).toBe(5);
    expect(valueAt(all, 'days_per_week', '2026-11-09')).toBe(5);
  });
  it('AC27 只修改下月预算，本月不变', () => {
    const segs = [seg('budget_cents', 300000, '2026-10', null, 1)];
    const ch = planRuleChange(segs, 'budget_cents', 350000, 'next_and_future', '2026-10', '2026-11');
    const all = [...segs, { ...ch.segment, seq: 2 }];
    expect(valueAt(all, 'budget_cents', '2026-10')).toBe(300000);
    expect(valueAt(all, 'budget_cents', '2026-11')).toBe(350000);
  });
  it('AC42 已排定下月3500，改为本月及以后2800，下月也变2800并列出被替换的设置', () => {
    const segs = [seg('budget_cents', 300000, '2026-10', null, 1), seg('budget_cents', 350000, '2026-11', null, 2)];
    const ch = planRuleChange(segs, 'budget_cents', 280000, 'current_and_future', '2026-10', '2026-11');
    const all = [...segs, { ...ch.segment, seq: 3 }];
    expect(valueAt(all, 'budget_cents', '2026-10')).toBe(280000);
    expect(valueAt(all, 'budget_cents', '2026-11')).toBe(280000);
    expect(ch.replacedFuture).toEqual([{ fromPeriod: '2026-11', value: 350000 }]);
  });
  it('仅当前周期保留已排定的未来规则', () => {
    const segs = [seg('budget_cents', 300000, '2026-10', null, 1), seg('budget_cents', 350000, '2026-11', null, 2)];
    const ch = planRuleChange(segs, 'budget_cents', 200000, 'current_only', '2026-10', '2026-11');
    const all = [...segs, { ...ch.segment, seq: 3 }];
    expect(valueAt(all, 'budget_cents', '2026-10')).toBe(200000);
    expect(valueAt(all, 'budget_cents', '2026-11')).toBe(350000);
    expect(valueAt(all, 'budget_cents', '2026-12')).toBe(350000);
  });
});
