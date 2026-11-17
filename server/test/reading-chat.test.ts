import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeLlm, type Llm } from '../src/ai/llm.js';
import type { Turn, TurnWrite } from '../src/ai/turn.js';
import { Chat, type Card } from '../src/services/chat.js';
import { execute, type Action } from '../src/services/engine.js';
import { getPlanTemplate } from '../src/services/templates.js';
import { studyView } from '../src/services/views.js';
import { setup } from './helpers.js';

const T = new Date('2026-11-16T12:00:00+08:00');
const today = '2026-11-16';
function w(op: TurnWrite['op'], patch: Partial<TurnWrite> = {}): TurnWrite {
  return { op, is_fact: true, amount_text: null, currency: 'CNY', duration_value: null, duration_unit: null,
    category: null, date_kind: 'today', days_ago: null, date: null, note: null, plan_id: null, plan_name: null,
    activity: '阅读', days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null, ...patch };
}
const card = <K extends Card['type']>(cards: Card[], type: K) => cards.find(c => c.type === type) as Extract<Card, { type: K }> | undefined;
const script = (map: Record<string, Partial<Turn>>) => new FakeLlm(text => map[text] ?? { intent: 'smalltalk', reply: '收到。' });

async function reading() {
  const c = await setup();
  const run = (...actions: Action[]) => execute(c.db, { ...c.at(T.toISOString()), templateCapability: true }, randomUUID(), actions);
  const adopted = await run({ type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 });
  const planId = adopted.templatePlan!.planId;
  const state = () => getPlanTemplate(c.db, c.userId, planId, today);
  const records = () => c.db.query<{ id: string; minutes: number; note: string; version: number }>('SELECT id,minutes,note,version FROM records WHERE plan_id=$1 AND NOT deleted ORDER BY created_at', [planId]);
  const send = (chat: Chat, text: string, extra: Partial<Parameters<Chat['send']>[1]> = {}) => chat.send(c.userId, { clientMsgId: randomUUID(), text, inputAt: T, scopePlanId: planId, templateCapability: true, ...extra });
  return { ...c, run, planId, state, records, send };
}

describe('官方阅读对话', () => {
  it('设置不产生事实，25→35修改同条；scope隔离其他计划、查询与刷新历史', async () => {
    const c = await reading();
    const other = await c.run({ type: 'create_study', name: '英语学习', activity: '英语学习' });
    const otherId = (other.items[0] as { plan: { id: string } }).plan.id;
    const llm = script({
      '每周五天，每天二十分钟，当前读《置身事内》': { intent: 'write', writes: [w('configure_reading_plan', { days_per_week: 5, min_minutes: 20, reading_book: '置身事内', complete_setup: true })] },
      '今天读了25分钟，读到第35页': { intent: 'write', writes: [w('add_study', { duration_value: 25, duration_unit: 'minute', reading_position: '第35页', reading_book: '模型猜的书' })] },
      '刚才其实是35分钟': { intent: 'write', writes: [w('edit_record', { duration_value: 35, duration_unit: 'minute' })] },
      '这周读了多久': { intent: 'query', query: { kind: 'study_progress', plan_id: otherId, period: 'this_week', from: null, to: null, category: null } },
    });
    const chat = new Chat(c.db, llm);
    const configured = await c.send(chat, '每周五天，每天二十分钟，当前读《置身事内》');
    expect(configured.assistant.text).toBe('计划设置已更新。');
    expect(card(configured.assistant.cards, 'receipt')).toBeUndefined();
    expect((await c.state()).config).toMatchObject({ daysPerWeek: 5, minMinutes: 20, currentBook: '置身事内', setupStatus: 'ready' });
    expect(await c.records()).toHaveLength(0);
    const first = await c.send(chat, '今天读了25分钟，读到第35页');
    const original = (await c.records())[0]!;
    expect(original).toMatchObject({ minutes: 25, note: '书名：《置身事内》\n阅读位置：第35页' });
    await c.run({ type: 'add_study', planId: otherId, minutes: 60, date: today });
    const correction = await c.send(chat, '刚才其实是35分钟');
    const rows = await c.records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: original.id, minutes: 35, note: original.note, version: 2 });
    expect(card(correction.assistant.cards, 'receipt')!.items[0]!.type).toBe('record_edited');
    const query = await c.send(chat, '这周读了多久');
    const result = card(query.assistant.cards, 'query');
    expect(result).toMatchObject({ kind: 'study_week', plan: { id: c.planId }, stats: { totalMinutes: 35, recordDays: 1, metDays: 1 } });
    const view = await studyView(c.db, c.userId, c.planId, today, today);
    expect(view.stats.totalMinutes).toBe(35);
    expect((await new Chat(c.db, llm).history(c.userId, 50, undefined, c.planId)).every(message => message.scopePlanId === c.planId)).toBe(true);
    expect((await chat.lookup(c.userId, first.user.clientMsgId!))!.user.id).toBe(first.user.id);
    expect(llm.calls.at(-1)!.system).toContain('当前书籍（来源：该计划明确设置）="置身事内"');
    expect(llm.calls.at(-1)!.system).not.toContain('英语学习 · 60');
  });

  it('缺分钟追问，页码不当分钟，选择继续保留书名位置；取消不写入', async () => {
    const c = await reading();
    const chat = new Chat(c.db, script({ '读《置身事内》到第35页': { intent: 'write', writes: [w('add_study', { reading_book: '置身事内', reading_position: '第35页' })] } }));
    const first = await c.send(chat, '读《置身事内》到第35页');
    const pending = card(first.assistant.cards, 'clarify')!;
    expect(pending.question).toContain('多长时间');
    expect(await c.records()).toHaveLength(0);
    const option = pending.options.find(option => option.label === '30 分钟')!;
    await c.send(chat, option.label, { pendingId: pending.pendingId, choice: option.id });
    expect((await c.records())[0]).toMatchObject({ minutes: 30, note: '书名：《置身事内》\n阅读位置：第35页' });
    const second = card((await c.send(chat, '读《置身事内》到第35页')).assistant.cards, 'clarify')!;
    const cancel = second.options.find(option => option.style === 'cancel')!;
    await c.send(chat, cancel.label, { pendingId: second.pendingId, choice: cancel.id });
    expect(await c.records()).toHaveLength(1);
  });

  it('没有明确书名来源时不采用模型猜测，目标误判为事实仍不记录', async () => {
    const c = await reading();
    const chat = new Chat(c.db, script({
      '今天读了25分钟': { intent: 'write', writes: [w('add_study', { duration_value: 25, duration_unit: 'minute', reading_book: '猜测书名' })] },
      '每天20分钟': { intent: 'write', writes: [w('add_study', { duration_value: 20, duration_unit: 'minute' })] },
    }));
    await c.send(chat, '今天读了25分钟');
    expect((await c.records())[0]!.note).toBe('');
    await c.send(chat, '每天20分钟');
    expect(await c.records()).toHaveLength(1);
  });

  it('两个官方阅读计划先选归属，使用所选计划的书籍；不同scope的待补充不混用', async () => {
    const c = await reading();
    const second = await c.run({ type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 });
    const secondId = second.templatePlan!.planId;
    await c.run({ type: 'configure_reading_plan', planId: secondId, expectedVersion: second.templatePlan!.config.version, patch: { currentBook: '第二本书' } });
    const llm = script({ '读了25分钟': { intent: 'write', writes: [w('add_study', { duration_value: 25, duration_unit: 'minute' })] }, '读了书': { intent: 'write', writes: [w('add_study')] } });
    const chat = new Chat(c.db, llm);
    const pending = card((await c.send(chat, '读了25分钟', { scopePlanId: null })).assistant.cards, 'clarify')!;
    expect(pending.question).toContain('哪个计划');
    expect(await c.records()).toHaveLength(0);
    const choice = pending.options.find(option => option.label === second.templatePlan!.config.name)!;
    await c.send(chat, choice.label, { scopePlanId: null, pendingId: pending.pendingId, choice: choice.id });
    const records = await c.db.query<{ plan_id: string; note: string }>('SELECT plan_id,note FROM records WHERE user_id=$1 AND NOT deleted', [c.userId]);
    expect(records).toEqual([{ plan_id: secondId, note: '书名：《第二本书》' }]);
    await c.send(chat, '读了书');
    await c.send(chat, '随便聊聊', { scopePlanId: secondId });
    expect(llm.calls.at(-1)!.system).toContain('待补充内容：无');
  });

  it('旧客户端仍可调整旧目标，但不能执行新配置；新客户端合并同计划设置', async () => {
    const c = await reading();
    const chat = new Chat(c.db, script({
      '每周四天': { intent: 'write', writes: [w('set_study_goal', { days_per_week: 4 })] },
      '当前读《置身事内》': { intent: 'write', writes: [w('configure_reading_plan', { reading_book: '置身事内' })] },
      '每周五天，每天20分钟': { intent: 'write', writes: [w('set_study_goal', { days_per_week: 5 }), w('set_study_goal', { min_minutes: 20 })] },
    }));
    await c.send(chat, '每周四天', { templateCapability: false });
    expect((await c.state()).config.daysPerWeek).toBe(4);
    const denied = await c.send(chat, '当前读《置身事内》', { templateCapability: false });
    expect(denied.assistant.text).toContain('没有保存');
    expect((await c.state()).config.currentBook).toBeNull();
    await c.send(chat, '每周五天，每天20分钟');
    expect((await c.state()).config).toMatchObject({ daysPerWeek: 5, minMinutes: 20 });
    expect(await c.records()).toHaveLength(0);
  });

  it('配置与记录混合不部分保存，配置冲突不覆盖较新书籍', async () => {
    const c = await reading();
    const mixed = new Chat(c.db, script({ '设置每天20分钟，今天读25分钟': { intent: 'write', writes: [w('configure_reading_plan', { min_minutes: 20 }), w('add_study', { duration_value: 25, duration_unit: 'minute' })] } }));
    expect((await c.send(mixed, '设置每天20分钟，今天读25分钟')).assistant.text).toContain('这次都没有保存');
    expect(await c.records()).toHaveLength(0);
    expect((await c.state()).config.minMinutes).toBeNull();
    const fake = script({ '每天20分钟': { intent: 'write', writes: [w('configure_reading_plan', { min_minutes: 20 })] } });
    const changing: Llm = { async plan(system, text) {
      await c.run({ type: 'configure_reading_plan', planId: c.planId, expectedVersion: (await c.state()).config.version, patch: { currentBook: '较新的书籍' } });
      return fake.plan(system, text);
    } };
    const stale = await c.send(new Chat(c.db, changing), '每天20分钟');
    expect(card(stale.assistant.cards, 'error')).toBeDefined();
    expect((await c.state()).config).toMatchObject({ currentBook: '较新的书籍', minMinutes: null });
  });

  it('合成备注超长时要求缩短，不静默截断，也不返回未知结果', async () => {
    const c = await reading();
    const book = '书'.repeat(80), position = '位'.repeat(40), reflection = '感'.repeat(40), note = '注'.repeat(40);
    const text = `今天读《${book}》25分钟，${position}，${reflection}，${note}`;
    const result = await c.send(new Chat(c.db, script({ [text]: { intent: 'write', writes: [w('add_study', { duration_value: 25, duration_unit: 'minute', reading_book: book, reading_position: position, reading_reflection: reflection, note })] } })), text);
    expect(result.transient).toBe(false);
    expect(card(result.assistant.cards, 'clarify')!.question).toContain('200');
    expect(await c.records()).toHaveLength(0);
  });

  it('无AI授权不调用模型，其他账户scope不能读或写', async () => {
    const c = await reading();
    const llm = script({});
    const chat = new Chat(c.db, llm);
    await c.db.query('UPDATE users SET ai_consent=false WHERE id=$1', [c.userId]);
    await expect(c.send(chat, '今天读25分钟')).rejects.toMatchObject({ code: 'ai_consent_required' });
    const [other] = await c.db.query<{ id: string }>("INSERT INTO users (dev_name,ai_consent) VALUES ('other-reading-account',true) RETURNING id");
    await expect(chat.history(other!.id, 50, undefined, c.planId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(chat.send(other!.id, { clientMsgId: randomUUID(), text: '今天读25分钟', inputAt: T, scopePlanId: c.planId, templateCapability: true })).rejects.toMatchObject({ code: 'not_found' });
    expect(llm.calls).toHaveLength(0);
    expect(await c.records()).toHaveLength(0);
  });
});
