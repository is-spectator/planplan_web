import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLlm } from '../src/ai/llm.js';
import { sanitizeTurn } from '../src/ai/turn.js';
import { definitionBody } from '../src/ai/creation.js';
import { Chat, type Card, type ChatInput, type ChatReply } from '../src/services/chat.js';
import { createCreationDraft, saveCreationDraft, updateCreationDraft } from '../src/services/creation-drafts.js';
import { execute } from '../src/services/engine.js';
import { getAvailableTemplate } from '../src/services/templates.js';
import { setup, type Db } from './helpers.js';

const at = new Date('2026-11-16T04:00:00Z');
const opened: Db[] = [];
afterEach(async () => { for (const db of opened.splice(0)) await db.close(); });
const card = <K extends Card['type']>(reply: ChatReply, kind: K) => reply.assistant.cards.find(value => value.type === kind) as Extract<Card, { type: K }> | undefined;

async function fixture() {
  const c = await setup(); opened.push(c.db);
  const body = definitionBody(await getAvailableTemplate(c.db, 'official.water'));
  body.name = '私人专属饮水'; body.example.config.name = '私人专属饮水';
  const saved = await c.db.tx(async q => {
    const draft = await createCreationDraft(q, c.userId);
    const updated = await updateCreationDraft(q, c.userId, draft.id, draft.version, body);
    return saveCreationDraft(q, c.userId, draft.id, updated.version);
  }, c.userId);
  const context = { userId: c.userId, inputAt: at, source: 'form' as const, genericCapability: true, privateTemplateCapability: true };
  await execute(c.db, context, randomUUID(), [{ type: 'create_ledger' }]);
  const privatePlan = (await execute(c.db, context, randomUUID(), [{ type: 'adopt_template', templateId: saved.savedTemplate!.id, templateVersion: saved.savedTemplate!.version }])).templatePlan!;
  const llm = new FakeLlm(text => sanitizeTurn(text.includes('撤销')
    ? { intent: 'write', writes: [{ op: 'undo_last' }] }
    : text.includes('喝水')
      ? { intent: 'write', writes: [{ op: 'add_generic_record', is_fact: true, plan_id: privatePlan.planId, date_kind: 'today', generic_fields: [{ field_id: 'amountMl', value: 432, unit: 'ml', unit_size: null, unit_size_unit: null }] }] }
      : { intent: 'write', writes: [{ op: 'add_expense', is_fact: true, amount_text: '18', currency: 'CNY', category: '餐饮', date_kind: 'today', note: '午饭' }] })!);
  const chat = new Chat(c.db, llm);
  const send = (text: string, extra: Partial<ChatInput> = {}) => chat.send(c.userId, { clientMsgId: randomUUID(), text, inputAt: at, genericCapability: true, privateTemplateCapability: true, ...extra });
  const ordinary = card(await send('午饭18元'), 'receipt')!;
  const personal = card(await send('今天喝水432ml'), 'receipt')!;
  expect(ordinary).toBeDefined(); expect(personal).toBeDefined();
  const records = () => c.db.query<{ kind: string; deleted: boolean; fields: unknown; note: string }>('SELECT kind,deleted,fields,note FROM records WHERE user_id=$1 ORDER BY created_at,id', [c.userId]);
  return { ...c, chat, send, records, ordinary, personal, privatePlan };
}

function expectBlocked(reply: ChatReply, c: Awaited<ReturnType<typeof fixture>>) {
  expect(reply.transient).toBe(false);
  expect(reply.assistant.text).toContain('新版网页');
  expect(reply.assistant.cards).toEqual([]);
  expect(JSON.stringify(reply.assistant)).not.toContain(c.privatePlan.planId);
  expect(JSON.stringify(reply.assistant)).not.toContain('私人专属饮水');
  expect(JSON.stringify({ text: reply.assistant.text, cards: reply.assistant.cards })).not.toContain('432');
  expect(JSON.stringify(reply.assistant)).not.toContain(c.personal.operationId);
}

describe('私人回执撤销的旧端能力边界', () => {
  it('generic=true/private=false 的裸撤销不生成私人候选或任何待确认动作', async () => {
    const c = await fixture();
    const reply = await c.send('撤销', { privateTemplateCapability: false });
    expectBlocked(reply, c);
    expect(await c.records()).toHaveLength(2);
    expect((await c.records()).every(row => !row.deleted)).toBe(true);
    expect(await c.db.query('SELECT id FROM pending_actions WHERE user_id=$1', [c.userId])).toHaveLength(0);
  });

  it('最新是私人回执时撤销刚才不跳过它，不能误撤更早普通记录', async () => {
    const c = await fixture();
    const reply = await c.send('撤销刚才', { privateTemplateCapability: false });
    expectBlocked(reply, c);
    expect((await c.records()).map(row => ({ kind: row.kind, deleted: row.deleted }))).toEqual([{ kind: 'expense', deleted: false }, { kind: 'generic', deleted: false }]);
    expect(await c.db.query('SELECT id FROM operations WHERE user_id=$1 AND (undone OR kind=$2)', [c.userId, 'undo'])).toHaveLength(0);
    const recovered = await c.chat.lookup(c.userId, reply.user.clientMsgId!);
    expect(recovered?.assistant).toEqual(reply.assistant);
  });

  it('新版已生成的私人撤销选项，转到旧端点击时也被阻止且不回退旧普通回执', async () => {
    const c = await fixture();
    const pending = card(await c.send('撤销'), 'clarify')!;
    const option = pending.options.find(value => value.label.includes('私人专属饮水'))!;
    expect(option).toBeDefined();
    const reply = await c.send(option.label, { pendingId: pending.pendingId, choice: option.id, privateTemplateCapability: false });
    expectBlocked(reply, c);
    expect((await c.records()).every(row => !row.deleted)).toBe(true);
    expect(await c.db.query('SELECT id FROM operations WHERE user_id=$1 AND undone', [c.userId])).toHaveLength(0);
  });

  it('新版仍可精确撤销最新私人回执，更早普通记录保留', async () => {
    const c = await fixture();
    const reply = await c.send('撤销刚才');
    expect(card(reply, 'receipt')?.items[0]).toMatchObject({ type: 'undone', of: c.personal.operationId });
    expect((await c.records()).map(row => ({ kind: row.kind, deleted: row.deleted }))).toEqual([{ kind: 'expense', deleted: false }, { kind: 'generic', deleted: true }]);
    const [ordinary] = await c.db.query<{ undone: boolean }>('SELECT undone FROM operations WHERE id=$1', [c.ordinary.operationId]);
    expect(ordinary!.undone).toBe(false);
  });
});
