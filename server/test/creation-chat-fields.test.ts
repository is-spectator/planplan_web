import { afterEach, describe, expect, it } from 'vitest';
import { createCreationDraft, updateCreationDraft, saveCreationDraft } from '../src/services/creation-drafts.js';
import { execute } from '../src/services/engine.js';
import { Chat } from '../src/services/chat.js';
import { OpenAICompatibleLlm } from '../src/ai/llm.js';
import { genericSummary } from '../src/services/generic.js';
import { getPlanTemplate } from '../src/services/templates.js';
import type { TurnGenericField } from '../src/ai/turn.js';
import type { DefinitionBody } from '../src/ai/creation.js';
import { setup, type Db } from './helpers.js';

const today = '2026-11-16', at = new Date(`${today}T04:00:00Z`);
const definition: DefinitionBody = {
  name: '阅读记录', description: '分别记录书名、页数、时长、花费、状态、标签和完成情况。',
  configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }, { id: 'dailyMinutes', label: '每日时长目标', type: 'duration', unit: 'minute', min: 1, max: 1440, required: false }],
  recordFields: [
    { id: 'date', label: '日期', type: 'date', required: true },
    { id: 'book', label: '书名', type: 'text', maxLength: 80, required: true },
    { id: 'pages', label: '本次阅读页数', type: 'integer', min: 1, max: 10000, required: true },
    { id: 'minutes', label: '阅读时长', type: 'duration', unit: 'minute', min: 1, max: 1440, required: true },
    { id: 'cost', label: '本次花费', type: 'money', unit: 'CNY_cent', min: 0, max: 1000000, required: false },
    { id: 'mood', label: '状态', type: 'single_select', options: ['专注', '轻松'], required: false },
    { id: 'tags', label: '标签', type: 'multi_select', options: ['小说', '纸书', '电子书'], required: false },
    { id: 'finished', label: '读完了', type: 'boolean', required: false },
  ],
  metrics: [{ id: 'minutesTotal', label: '当日时长', operation: 'sum', fieldId: 'minutes', period: 'day' }, { id: 'progress', label: '时长进度', operation: 'goal_progress', fieldId: 'minutes', goalFieldId: 'dailyMinutes', period: 'day' }],
  components: ['summary', 'goal', 'records'], example: { config: { name: '阅读记录', startDate: today, dailyMinutes: 60 }, record: { date: today, book: '合成示例书', pages: 10, minutes: 20, cost: 0, mood: '专注', tags: ['纸书'], finished: false } },
};
const field = (field_id: string, value: TurnGenericField['value'], unit: string | null = null): TurnGenericField => ({ field_id, value, unit, unit_size: null, unit_size_unit: null });
const values = () => [field('book', '合成书名'), field('pages', 12), field('minutes', .5, '小时'), field('cost', 20, '元'), field('mood', '专注'), field('tags', ['小说', '纸书']), field('finished', false)];
const opened: Db[] = [];
afterEach(async () => { for (const db of opened.splice(0)) await db.close(); });

async function fixture() {
  const c = await setup(); opened.push(c.db);
  const saved = await c.db.tx(async q => {
    const draft = await createCreationDraft(q, c.userId);
    const updated = await updateCreationDraft(q, c.userId, draft.id, draft.version, definition);
    return saveCreationDraft(q, c.userId, draft.id, updated.version);
  }, c.userId);
  const context = { userId: c.userId, inputAt: at, source: 'form' as const, templateCapability: true, ledgerTemplateCapability: true, genericCapability: true, privateTemplateCapability: true };
  const plan = (await execute(c.db, context, 'adopt-private-template', [{ type: 'adopt_template', templateId: saved.savedTemplate!.id, templateVersion: saved.savedTemplate!.version }])).templatePlan!;
  let turn: unknown = { intent: 'smalltalk', reply: '合成测试' }, n = 0, lastSystem = '';
  const llm = new OpenAICompatibleLlm('synthetic-key', 'https://fixture.test/v1', 'synthetic-provider-model', 'compact', 100, { provider: 'openrouter', fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string); lastSystem = body.messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(turn) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }), { headers: { 'content-type': 'application/json' } });
  } });
  const chat = new Chat(c.db, llm);
  const send = async (next: unknown, text: string) => { turn = next; return chat.send(c.userId, { clientMsgId: `private-fields-${++n}`, text, inputAt: at, scopePlanId: plan.planId, genericCapability: true, privateTemplateCapability: true, recoveryCapability: true }); };
  const add = (fields = values(), text = '今天阅读合成书名12页、半小时，花费20元，状态专注，标签小说和纸书，还没读完') => send({ intent: 'write', writes: [{ op: 'add_generic_record', is_fact: true, plan_id: plan.planId, date_kind: 'today', generic_fields: fields }] }, text);
  const records = () => c.db.query<{ id: string; fields: Record<string, unknown>; version: number }>('SELECT id,fields,version FROM records WHERE user_id=$1 AND deleted=false ORDER BY created_at,id', [c.userId]);
  return { ...c, plan, send, add, records, system: () => lastSystem };
}

describe('私人模板八类型经过真实provider解析和Chat写入（合成HTTP与真实数据库）', () => {
  it('设置时长目标不造事实；8类型按独立字段保存，元和小时精确换算', async () => {
    const c = await fixture();
    const configured = await c.send({ intent: 'write', writes: [{ op: 'configure_generic_plan', plan_id: c.plan.planId, generic_fields: [field('dailyMinutes', 1, 'hour')], complete_setup: true }] }, '每天目标1小时，设置完成');
    expect(configured.transient).toBe(false);
    expect(await c.records()).toHaveLength(0);
    expect((await getPlanTemplate(c.db, c.userId, c.plan.planId, today)).config.values?.dailyMinutes).toBe(60);
    const result = await c.add();
    expect(result.transient).toBe(false);
    const [record] = await c.records();
    expect(record!.fields).toEqual({ date: today, book: '合成书名', pages: 12, minutes: 30, cost: 2000, mood: '专注', tags: ['小说', '纸书'], finished: false });
    expect(c.system()).toContain('"type":"multi_select"');
    expect(c.system()).toContain('"type":"boolean"');
    expect(await genericSummary(c.db, c.userId, c.plan.planId, today, today)).toMatchObject({ recordCount: 1, metrics: [{ id: 'minutesTotal', value: 30 }, { id: 'progress', target: 60, value: 30, remaining: 30, progressPct: 50 }] });
    const queried = await c.send({ intent: 'query', query: { kind: 'generic_summary', plan_id: c.plan.planId, period: 'today', from: null, to: null, category: null } }, '今天阅读多久，离目标还有多少分钟？');
    expect(queried.assistant.text).toContain('30 分钟');
    expect(queried.assistant.text).toContain('目标 60 分钟');
    expect(queried.assistant.text).not.toContain('minute');
  });

  it('修改多选、是否和金额时保留其他字段；false和空多选不变成null', async () => {
    const c = await fixture(); await c.add(); const [record] = await c.records();
    const result = await c.send({ intent: 'write', writes: [{ op: 'edit_generic_record', record_id: record!.id, plan_id: c.plan.planId, generic_fields: [field('tags', []), field('finished', true), field('cost', 50, '分')] }] }, '把这条标签清空，已经读完，花费改成50分');
    expect(result.transient).toBe(false);
    const rows = await c.records(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: record!.id, version: 2, fields: { ...record!.fields, tags: [], finished: true, cost: 50 } });
    await c.send({ intent: 'write', writes: [{ op: 'edit_generic_record', record_id: record!.id, plan_id: c.plan.planId, generic_fields: [field('cost', null)] }] }, '清空这条的花费');
    const [cleared] = await c.records();
    expect(cleared).toMatchObject({ id: record!.id, version: 3, fields: { ...record!.fields, tags: [], finished: true, cost: null } });
  });

  it.each([
    ['金额未说明单位', () => values().map(f => f.field_id === 'cost' ? { ...f, unit: null } : f), '今天阅读合成书名12页、半小时，金额20'],
    ['未知货币', () => values().map(f => f.field_id === 'cost' ? { ...f, unit: 'USD' } : f), '今天阅读合成书名12页、半小时，花费20美元'],
    ['不整分钟', () => values().map(f => f.field_id === 'minutes' ? { ...f, value: .001, unit: 'hour' } : f), '今天阅读合成书名12页、0.001小时，花费20元'],
    ['重复多选', () => values().map(f => f.field_id === 'tags' ? { ...f, value: ['小说', '小说'] } : f), '今天阅读合成书名12页、半小时，花费20元，标签小说'],
    ['非法选项', () => values().map(f => f.field_id === 'mood' ? { ...f, value: '并不存在' } : f), '今天阅读合成书名12页、半小时，花费20元，状态不明'],
  ])('%s时保持澄清且完全不写入', async (_label, fields, text) => {
    const c = await fixture(), result = await c.add(fields(), text);
    expect(result.transient).toBe(false);
    expect(result.assistant.cards.some(card => card.type === 'clarify')).toBe(true);
    expect(await c.records()).toHaveLength(0);
  });

  it('没提可选是否和多选时不补造默认值', async () => {
    const c = await fixture();
    await c.add(values().filter(f => !['finished', 'tags'].includes(f.field_id)), '今天阅读合成书名12页、半小时，花费20元，状态专注');
    const [record] = await c.records();
    expect(record).toBeDefined();
    expect(record!.fields).not.toHaveProperty('finished');
    expect(record!.fields).not.toHaveProperty('tags');
  });
});
