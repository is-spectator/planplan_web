import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeLlm } from '../src/ai/llm.js';
import type { TurnWrite } from '../src/ai/turn.js';
import { createApp } from '../src/api/app.js';
import { issueToken } from '../src/api/auth.js';
import { Chat, type Card } from '../src/services/chat.js';
import { execute, type OperationResult } from '../src/services/engine.js';
import { setup } from './helpers.js';

const T = new Date('2026-11-16T12:00:00+08:00'), today = '2026-11-16';
const write = (planId: string | null = null): TurnWrite => ({
  op: 'add_study', is_fact: true, amount_text: null, currency: 'CNY', duration_value: 25, duration_unit: 'minute',
  category: null, date_kind: 'today', days_ago: null, date: null, note: null, plan_id: planId, plan_name: null,
  activity: '阅读', days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null,
});
const planId = (result: OperationResult) => {
  const item = result.items[0]!; if (item.type !== 'plan_created') throw new Error('fixture must create plan'); return item.plan.id;
};
const card = <K extends Card['type']>(cards: Card[], type: K) => cards.find(c => c.type === type) as Extract<Card, { type: K }> | undefined;
async function fixture() {
  const c = await setup();
  const archivedId = planId(await c.run(T.toISOString(), { type: 'create_study', name: '旧阅读计划', activity: '阅读' }));
  await c.run(T.toISOString(), { type: 'add_study', planId: archivedId, minutes: 20, date: today });
  await c.run(T.toISOString(), { type: 'archive_plan', planId: archivedId });
  const activeId = planId(await c.run(T.toISOString(), { type: 'create_study', name: '新阅读计划', activity: '阅读' }));
  const rows = () => c.db.query<{ plan_id: string; minutes: number }>('SELECT plan_id,minutes FROM records WHERE NOT deleted ORDER BY created_at,id');
  const send = (chat: Chat, text: string, extra: Partial<Parameters<Chat['send']>[1]> = {}) => chat.send(c.userId, { clientMsgId: randomUUID(), text, inputAt: T, scopePlanId: archivedId, ...extra });
  return { ...c, archivedId, activeId, rows, send };
}

describe('阅读计划归档范围与显式目标', () => {
  it.each([false, true])('归档范围保留目标（模型选择另一计划=%s），确认后恢复原计划并保存一次', async modelSelectsActive => {
    const c = await fixture();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write(modelSelectsActive ? c.activeId : null)] })));
    const first = await c.send(chat, '读了25分钟');
    const pending = card(first.assistant.cards, 'clarify')!;
    expect(pending.question).toContain('旧阅读计划'); expect(pending.question).toContain('归档');
    expect(await c.rows()).toEqual([{ plan_id: c.archivedId, minutes: 20 }]);
    const choice = pending.options.find(option => option.label === '恢复并记录')!;
    const input = { clientMsgId: randomUUID(), pendingId: pending.pendingId, choice: choice.id };
    const out = await c.send(chat, choice.label, input);
    expect(card(out.assistant.cards, 'receipt')?.items.map(item => item.type)).toEqual(['plan_updated', 'study_added']);
    await c.send(chat, choice.label, input);
    expect(await c.rows()).toEqual([{ plan_id: c.archivedId, minutes: 20 }, { plan_id: c.archivedId, minutes: 25 }]);
    expect(await c.db.query('SELECT status FROM plans WHERE id=$1', [c.archivedId])).toEqual([{ status: 'active' }]);
  });

  it.each(['missing', 'other-user', 'wrong-kind'])('显式%s目标不按活动或唯一活跃计划自动回退', async invalid => {
    const c = await fixture(); let invalidId: string = randomUUID();
    if (invalid === 'wrong-kind') invalidId = planId(await c.run(T.toISOString(), { type: 'create_ledger' }));
    if (invalid === 'other-user') {
      const [other] = await c.db.query<{ id: string }>('INSERT INTO users(dev_name) VALUES($1) RETURNING id', [`study-other-${randomUUID()}`]);
      invalidId = planId(await execute(c.db, { userId: other!.id, inputAt: T, source: 'form' }, randomUUID(), [{ type: 'create_study', activity: '秘密阅读' }]));
    }
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write(invalidId)] })));
    const out = await c.send(chat, '读了25分钟');
    expect(card(out.assistant.cards, 'clarify')).toBeDefined(); expect(card(out.assistant.cards, 'receipt')).toBeUndefined();
    expect(JSON.stringify(out.assistant)).not.toContain(invalidId);
    expect(JSON.stringify(out.assistant)).not.toContain('秘密阅读');
    expect(await c.rows()).toEqual([{ plan_id: c.archivedId, minutes: 20 }]);
    expect(await c.db.query('SELECT status FROM plans WHERE id=$1', [c.archivedId])).toEqual([{ status: 'archived' }]);
  });

  it('用户明确指定其他阅读计划时仍尊重明确归属', async () => {
    const c = await fixture();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write(c.activeId)] })));
    const out = await c.send(chat, '读了25分钟，记到新阅读计划');
    expect(card(out.assistant.cards, 'receipt')?.items[0]).toMatchObject({ type: 'study_added', record: { planId: c.activeId, minutes: 25 } });
    expect(await c.db.query('SELECT status FROM plans WHERE id=$1', [c.archivedId])).toEqual([{ status: 'archived' }]);
  });

  it('HTTP归档阅读查询不恢复；新增先确认，取消保留历史且不产生新记录', async () => {
    const c = await fixture();
    const cfg = { jwtSecret: new TextEncoder().encode('isolated-study-http-test-secret-xx'), appleAudience: null, devLogin: false };
    const token = await issueToken(cfg, c.userId, 0);
    const app = createApp(c.db, new FakeLlm(text => text === '今天读了多久？'
      ? { intent: 'query', query: { kind: 'study_progress', plan_id: null, period: 'today', from: null, to: null, category: null } }
      : { intent: 'write', writes: [write()] }), cfg);
    const post = (text: string, extra: Record<string, unknown> = {}) => app.request('/v1/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ clientMsgId: randomUUID(), text, scopePlanId: c.archivedId, inputAt: T.toISOString(), ...extra }) });
    const query = await post('今天读了多久？'); expect(query.status).toBe(200);
    expect(card((await query.json()).assistant.cards, 'query')).toMatchObject({ kind: 'study_range', plan: { id: c.archivedId, status: 'archived' }, totalMinutes: 20, recordDays: 1 });
    const first = await post('读了25分钟'); expect(first.status).toBe(200);
    const pending = card((await first.json()).assistant.cards, 'clarify')!; expect(pending.question).toContain('归档');
    const cancel = pending.options.find(option => option.style === 'cancel')!;
    expect((await post(cancel.label, { pendingId: pending.pendingId, choice: cancel.id })).status).toBe(200);
    expect(await c.rows()).toEqual([{ plan_id: c.archivedId, minutes: 20 }]);
    expect(await c.db.query('SELECT status FROM plans WHERE id=$1', [c.archivedId])).toEqual([{ status: 'archived' }]);
  });
});
