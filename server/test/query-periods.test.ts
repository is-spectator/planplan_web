import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeTurn, type TurnComparison, type TurnQuery } from '../src/ai/turn.js';
import { FakeLlm } from '../src/ai/llm.js';
import { Chat } from '../src/services/chat.js';
import { runQuery } from '../src/services/query.js';
import { queryText } from '../src/services/describe.js';
import { ledgerQueryTotals, studyRangeTotals } from '../src/services/query-totals.js';
import { makeFixture, INPUT_AT, TODAY, type Fixture, type FixtureName } from '../evals/fixtures.js';
import { CASES } from '../evals/cases.js';
import { runCase } from '../evals/runner.js';
import { judgeQuery } from '../evals/query-expectations.js';

const open: Fixture[] = [];
async function fixture(name: FixtureName = 'comparison') { const fx = await makeFixture(name); open.push(fx); return fx; }
afterEach(async () => { for (const fx of open.splice(0)) await fx.db.close(); });
const query = (fields: Partial<TurnQuery> = {}): TurnQuery => ({ kind: 'ledger_summary', plan_id: null, period: 'this_month', from: null, to: null, category: null, ...fields });
const compare = (metric: TurnComparison['metric'], fields: Partial<TurnComparison> = {}): TurnComparison => ({ metric, period: 'last_month', from: null, to: null, ...fields });

describe('按已记录事实统计日期区间', () => {
  it('SQL 学习聚合去重记录天数，排除删除、其他计划和其他用户', async () => {
    const fx = await fixture();
    expect(await studyRangeTotals(fx.db, fx.userId, fx.plans.read!, '2026-09-01', '2026-09-30')).toEqual({ totalMinutes: 60, recordDays: 2 });
    expect(await studyRangeTotals(fx.db, fx.userId, fx.plans.read!, '2026-10-01', TODAY)).toEqual({ totalMinutes: 45, recordDays: 1 });
    expect(await studyRangeTotals(fx.db, fx.userId, fx.plans.eng!, '2026-09-01', TODAY)).toEqual({ totalMinutes: 0, recordDays: 0 });
    const [other] = await fx.db.query<{ id: string }>(`INSERT INTO users DEFAULT VALUES RETURNING id`);
    expect(await studyRangeTotals(fx.db, other!.id, fx.plans.read!, '2026-09-01', TODAY)).toEqual({ totalMinutes: 0, recordDays: 0 });
    await fx.db.query(`UPDATE records SET deleted = true WHERE id = $1`, [fx.records.read25]);
    expect(await studyRangeTotals(fx.db, fx.userId, fx.plans.read!, TODAY, TODAY)).toEqual({ totalMinutes: 20, recordDays: 1 });
  });
  it('SQL 金额聚合按退款日、原支出分类计算，排除已删记录', async () => {
    const fx = await fixture();
    expect(await ledgerQueryTotals(fx.db, fx.userId, fx.plans.ledger!, '2026-10-01', TODAY, null)).toMatchObject({ spendCents: 35300, refundCents: 3000, netCents: 32300 });
    expect(await ledgerQueryTotals(fx.db, fx.userId, fx.plans.ledger!, '2026-10-01', TODAY, '购物')).toMatchObject({ spendCents: 19900, refundCents: 3000, netCents: 16900 });
    expect(await ledgerQueryTotals(fx.db, fx.userId, fx.plans.ledger!, '2026-09-01', '2026-09-30', '购物')).toMatchObject({ spendCents: 10000, refundCents: 2000, netCents: 8000 });
    await fx.db.query(`UPDATE records SET deleted = true WHERE id = $1`, [fx.records.lunch]);
    expect(await ledgerQueryTotals(fx.db, fx.userId, fx.plans.ledger!, TODAY, TODAY, null)).toMatchObject({ spendCents: 0, refundCents: 0, netCents: 0 });
  });
  it('具体消费按备注关键词统计，退款跟随原支出的备注', async () => {
    const fx = await fixture();
    expect(await ledgerQueryTotals(fx.db, fx.userId, fx.plans.ledger!, '2026-10-01', TODAY, null, ['耳机'])).toEqual({ spendCents: 19900, refundCents: 0, netCents: 19900, count: 1 });
    // 10/15 的退款对应 9 月的「上月购买」：退款按退款日计入本月，按原支出的备注匹配。
    expect(await ledgerQueryTotals(fx.db, fx.userId, fx.plans.ledger!, '2026-10-01', TODAY, null, ['上月购买'])).toEqual({ spendCents: 0, refundCents: 3000, netCents: -3000, count: 0 });
    expect(await ledgerQueryTotals(fx.db, fx.userId, fx.plans.ledger!, '2026-10-01', TODAY, null, ['打车', '地铁'])).toEqual({ spendCents: 600, refundCents: 0, netCents: 600, count: 1 });
    expect(await ledgerQueryTotals(fx.db, fx.userId, fx.plans.ledger!, '2026-10-01', TODAY, null, ['加油'])).toEqual({ spendCents: 0, refundCents: 0, netCents: 0, count: 0 });
    const card = await runQuery(fx.db, fx.userId, query({ keywords: ['地铁'] }), TODAY, null);
    expect(card).toMatchObject({ kind: 'ledger_range', from: '2026-10-01', to: TODAY, spendCents: 600, count: 1, label: '本月 · 地铁' });
    expect(queryText(card)).toBe('本月（10月1日–10月26日）「地铁」相关支出 ¥6，共 1 笔。');
    const today = await runQuery(fx.db, fx.userId, query({ period: 'today', keywords: ['加油', '油费'] }), TODAY, null);
    expect(queryText(today)).toBe('今天（10月26日）没有找到备注含「加油」/「油费」的支出记录。');
    // 预算是整本账的，关键词不改变预算查询。
    expect((await runQuery(fx.db, fx.userId, query({ kind: 'budget', keywords: ['地铁'] }), TODAY, null)).kind).toBe('ledger_month');
  });
  it('关键词清洗：去空白、去重、限长，空数组视为未指定', () => {
    const base = { intent: 'query', writes: [], missing: [], question: null, unsupported_kind: 'none', reply: '' };
    const kw = (keywords: unknown) => sanitizeTurn({ ...base, query: { kind: 'ledger_summary', period: 'today', keywords } })!.query!.keywords;
    expect(kw([' 加油 ', '加油', '', 3, '油费'])).toEqual(['加油', '油费']);
    expect(kw([])).toBeNull();
    expect(kw('加油')).toBeNull();
  });
  it('非周学习查询返回真实区间，不把记录天数写成达标天数', async () => {
    const fx = await fixture();
    const card = await runQuery(fx.db, fx.userId, query({ kind: 'study_progress', plan_id: fx.plans.read!, period: 'last_month' }), TODAY, null);
    expect(card).toMatchObject({ kind: 'study_range', from: '2026-09-01', to: '2026-09-30', totalMinutes: 60, recordDays: 2 });
    expect(queryText(card)).toContain('不评价周目标');
    expect(card).not.toHaveProperty('metDays');
    const week = await runQuery(fx.db, fx.userId, query({ kind: 'study_progress', plan_id: fx.plans.read!, period: 'this_week' }), TODAY, null);
    expect(week.kind).toBe('study_week');
  });
  it('无效日期不悄悄返回本月；跨年和未来结束日期有明确边界', async () => {
    const fx = await fixture();
    for (const [from, to] of [['2026-02-30', TODAY], [TODAY, '2026-10-01'], ['2026-11-01', '2026-11-30']]) {
      expect((await runQuery(fx.db, fx.userId, query({ period: 'custom', from: from!, to: to! }), TODAY, null)).kind).toBe('none');
    }
    const card = await runQuery(fx.db, fx.userId, query({ kind: 'study_progress', plan_id: fx.plans.read!, period: 'custom', from: '2025-12-31', to: '2026-12-31' }), TODAY, null);
    expect(card).toMatchObject({ from: '2025-12-31', to: TODAY, totalMinutes: 105, recordDays: 3, label: '指定区间截至今天' });
    const january = await runQuery(fx.db, fx.userId, query({ compare: compare('spend') }), '2027-01-03', null);
    expect(january).toMatchObject({ current: { from: '2027-01-01', to: '2027-01-03' }, previous: { from: '2026-12-01', to: '2026-12-31' }, changePct: null });
  });
});

describe('同计划同口径周期比较', () => {
  it('完整展示两段范围、单位和差值；零或负基数不造百分比', async () => {
    const fx = await fixture();
    const card = await runQuery(fx.db, fx.userId, query({ compare: compare('net') }), TODAY, null);
    expect(card).toMatchObject({ kind: 'comparison', metric: 'net', unit: 'CNY_cents', current: { from: '2026-10-01', to: TODAY, label: '本月截至今天', value: 32300 }, previous: { from: '2026-09-01', to: '2026-09-30', label: '上月完整月份', value: 8000 }, delta: 24300, changePct: 303.8 });
    expect(queryText(card)).toContain('本月截至今天（2026-10-01–2026-10-26）');
    expect(queryText(card)).toContain('上月完整月份（2026-09-01–2026-09-30）');
    const negative = await runQuery(fx.db, fx.userId, query({ period: 'custom', from: '2026-10-15', to: '2026-10-15', compare: compare('net', { period: 'custom', from: '2026-09-20', to: '2026-09-20' }) }), TODAY, null);
    expect(negative).toMatchObject({ current: { value: -3000 }, previous: { value: -2000 }, delta: -1000, changePct: null });
    const zero = await runQuery(fx.db, fx.userId, query({ period: 'today', compare: compare('spend', { period: 'yesterday' }) }), TODAY, null);
    expect(zero).toMatchObject({ delta: 2000, changePct: null });
    expect(queryText(zero)).not.toContain('Infinity');
    expect(card).not.toHaveProperty('keywords');
  });
  it('具体消费对比沿用备注范围，不把子集说成整本账', async () => {
    const fx = await fixture();
    const card = await runQuery(fx.db, fx.userId, query({ keywords: ['地铁'], compare: compare('spend') }), TODAY, null);
    expect(card).toMatchObject({ kind: 'comparison', category: null, keywords: ['地铁'], current: { value: 600 }, previous: { value: 0 }, delta: 600, changePct: null });
    const text = queryText(card);
    expect(text).toContain('备注含「地铁」');
    expect(text).toContain('¥6');
    expect(text).not.toContain('¥353');
    const scoped = await runQuery(fx.db, fx.userId, query({ category: '购物', keywords: ['上月购买'], compare: compare('spend') }), TODAY, null);
    expect(scoped).toMatchObject({ kind: 'comparison', category: '购物', keywords: ['上月购买'], current: { value: 0 }, previous: { value: 10000 }, delta: -10000 });
    expect(queryText(scoped)).toContain('购物、备注含「上月购买」');
    const study = await runQuery(fx.db, fx.userId, query({ kind: 'study_progress', plan_id: fx.plans.read!, keywords: ['阅读'], compare: compare('minutes') }), TODAY, null);
    expect(study.kind).toBe('comparison');
    expect(study).not.toHaveProperty('keywords');
  });
  it('不跨计划/单位，归属不存在或计划不明确时要求选择', async () => {
    const fx = await fixture();
    for (const fields of [
      { plan_id: '00000000-0000-0000-0000-000000000000', compare: compare('spend') },
      { plan_id: fx.plans.read!, compare: compare('spend') },
      { compare: compare('minutes') },
      { kind: 'study_progress' as const, compare: compare('minutes') },
      { kind: 'study_progress' as const, plan_id: fx.plans.read!, category: '餐饮' as const, compare: compare('minutes') },
    ]) expect((await runQuery(fx.db, fx.userId, query(fields), TODAY, null)).kind).toBe('none');
  });
  it('旧查询缺 compare 仍兼容；模型数值被丢弃，未知比较口径被拒绝', () => {
    expect(sanitizeTurn({ intent: 'query', query: query() })!.query!.compare).toBeNull();
    const raw = { ...query({ compare: compare('net') }), value: 999999, delta: 999999 };
    expect(sanitizeTurn({ query: raw })!.query).not.toHaveProperty('value');
    expect(sanitizeTurn({ query: { ...raw, compare: { ...compare('net'), metric: 'budget' } } })).toBeNull();
    expect(sanitizeTurn({ query: { ...raw, compare: { ...compare('net'), period: 'made_up' } } })).toBeNull();
  });
  it('FakeLlm 对话到 SQL 到历史回读都保留真实卡片，不使用模型答复里的数字', async () => {
    const fx = await fixture();
    const chat = new Chat(fx.db, new FakeLlm(() => ({ intent: 'query', query: query({ compare: compare('net') }), reply: '多花999999元，增长9999%' })));
    const reply = await chat.send(fx.userId, { clientMsgId: 'comparison-test', text: '本月净支出比上月多多少', inputAt: INPUT_AT });
    expect(judgeQuery('Q042', fx, reply.assistant.cards).pass).toBe(true);
    expect(reply.assistant.text).not.toContain('999999');
    const saved = (await chat.history(fx.userId)).find((m) => m.id === reply.assistant.id)!;
    expect(saved.cards).toEqual(reply.assistant.cards);
    const card = reply.assistant.cards[0]!;
    if (card.type !== 'query' || card.kind !== 'comparison') throw new Error('missing comparison');
    for (const wrong of [{ ...card, delta: 1 }, { ...card, unit: 'minutes' as const }, { ...card, previous: { ...card.previous, to: '2026-09-26' } }, { ...card, metric: 'spend' as const }]) {
      expect(judgeQuery('Q042', fx, [wrong]).pass).toBe(false);
    }
  });
});

// 预先写定参数，oracle 独立固定数字；FakeLlm 只代替语言解析，不绕过 Chat/SQL/保存检查。
const added: Partial<TurnQuery>[] = [
  { compare: compare('spend') }, { compare: compare('net') }, { compare: compare('refund') },
  { kind: 'study_progress', compare: compare('minutes') }, { kind: 'ledger_category', category: '购物', compare: compare('net') },
  { kind: 'study_progress', period: 'custom', from: '2026-10-01', to: TODAY, compare: compare('minutes', { period: 'custom', from: '2026-09-01', to: '2026-09-26' }) },
  { period: 'today', compare: compare('spend', { period: 'yesterday' }) },
  { kind: 'study_progress', period: 'recent_7_days' }, { kind: 'study_progress' },
  { kind: 'study_progress', period: 'custom', from: '2026-10-24', to: TODAY },
];
describe('E1 追加评测案例与独立数值 oracle', () => {
  it('原 Q001–Q040 的独立数值/范围期望全部保持通过', async () => {
    const fx = await fixture('default');
    const study = { kind: 'study_progress' as const, period: 'this_week' as const, plan_id: fx.plans.read! };
    const eng = { ...study, plan_id: fx.plans.eng! };
    const originals: Partial<TurnQuery>[] = [
      { kind: 'budget' }, {}, { kind: 'budget' }, { period: 'last_month' }, { period: 'today' },
      { period: 'yesterday' }, { period: 'recent_7_days' }, { period: 'this_week' },
      { kind: 'ledger_category', category: '餐饮' }, { kind: 'ledger_category', category: '交通' }, { kind: 'ledger_category', category: '购物' },
      { kind: 'budget' }, { kind: 'budget' }, study, study, { ...study, period: 'last_week' }, eng, { ...study, period: 'today' },
      { kind: 'overview' }, { kind: 'overview' }, { kind: 'overview' }, { period: 'custom', from: '2026-10-20', to: '2026-10-20' },
      {}, {}, { kind: 'ledger_category', category: '餐饮' }, { kind: 'ledger_category', category: '娱乐' }, { period: 'last_week' },
      { ...study, period: 'yesterday' }, study, eng, study, { kind: 'budget' }, { kind: 'budget' }, {},
      { kind: 'ledger_category', category: '餐饮', period: 'today' }, study, { kind: 'budget', period: 'last_month' }, {}, {}, study,
    ];
    for (const [index, fields] of originals.entries()) {
      const id = `Q${String(index + 1).padStart(3, '0')}`;
      const card = await runQuery(fx.db, fx.userId, query(fields), TODAY, null);
      const result = judgeQuery(id, fx, [card]);
      expect(result.pass, `${id}: ${result.reason}`).toBe(true);
    }
  });
  it.each(added.map((fields, index) => ({ id: `Q${41 + index < 100 ? '0' : ''}${41 + index}`, fields })))('$id 端到端通过', async ({ id, fields }) => {
    const c = CASES.find((c) => c.id === id)!;
    const llm = new FakeLlm((_user, system) => {
      const readId = /id=(\S+) 类型=学习 名称=阅读 /.exec(system)?.[1] ?? null;
      return { intent: 'query', query: query({ ...fields, plan_id: fields.kind === 'study_progress' ? readId : null }) };
    });
    const result = await runCase(c, 0, llm);
    expect(result.pass, result.reason).toBe(true);
    expect(result.wrongFactWrites).toBe(0);
  });
});
