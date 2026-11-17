import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREATION_SYSTEM_PROMPT, FakeCreationLlm, creationUserContent, creationHistoryAfterCancel, isCreationCancel, type CreationInput, type DefinitionBody } from '../src/ai/creation.js';
import { CREATION_FINGERPRINT, MeteredCreationLlm, OpenAICompatibleCreationLlm, createRuntimeCreationLlm } from '../src/ai/creation-runtime.js';
import { LlmError } from '../src/ai/llm.js';
import { UsageStore, attemptRequestDigest } from '../src/ai/usage-store.js';
import { BUILD_FINGERPRINT, type RuntimeConfig } from '../src/ai/runtime-config.js';
import type { TemplateDefinition } from '../src/templates/contracts.js';
import { setup } from './helpers.js';

const model = 'baidu/ernie-5.5-flash-preview:free';
const today = '2026-11-16';
const config: RuntimeConfig = { monthlyBudgetCny: '1000', timeoutMs: 20000, attemptRetentionDays: 30, pricing: null, fallback: null };
const input: CreationInput = { userId: 'synthetic-user-not-for-model', requestId: 'synthetic-request-not-for-model', today, instruction: '做一个每天记录饮水量和目标的模板', currentDefinition: null, history: [] };
const definition: DefinitionBody = {
  name: '饮水', description: '记录每日饮水量，查看目标进度。',
  configurationFields: [{ id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 }, { id: 'startDate', label: '开始日期', type: 'date', required: true }, { id: 'dailyGoal', label: '每日目标', type: 'integer', unit: 'ml', min: 1, required: false }],
  recordFields: [{ id: 'date', label: '日期', type: 'date', required: true }, { id: 'amount', label: '饮水量', type: 'integer', unit: 'ml', min: 1, required: true }],
  metrics: [{ id: 'total', label: '当日饮水量', operation: 'sum', fieldId: 'amount', period: 'day' }, { id: 'progress', label: '目标进度', operation: 'goal_progress', fieldId: 'amount', goalFieldId: 'dailyGoal', period: 'day' }],
  components: ['summary', 'goal', 'records'], example: { config: { name: '饮水', startDate: today, dailyGoal: 2000 }, record: { date: today, amount: 500 } },
};
const proposal = () => ({ kind: 'proposal' as const, reply: '可以记录饮水量，并查看当日汇总和目标进度。', definition: structuredClone(definition) });
function response(value: unknown, finish = 'stop', raw = false) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: raw ? value : JSON.stringify(value) }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { headers: { 'content-type': 'application/json' } });
}
function transport(fetch: typeof globalThis.fetch) { return new OpenAICompatibleCreationLlm({ apiKey: 'synthetic-key', baseURL: 'https://fixture.test/v1', model, provider: 'openrouter', timeoutMs: 60000, fetch }); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('创作协议与真实SDK传输（合成HTTP，无外网调用）', () => {
  it('使用独立草稿协议、指定模型和单供应商，保留usage而不注入日常记录动作', async () => {
    let body: Record<string, unknown> = {}, calls = 0;
    const llm = transport(async (_url, init) => { calls++; body = JSON.parse(init!.body as string); return response(proposal()); });
    const result = await llm.generate(input);
    expect(result).toMatchObject({ kind: 'proposal', definition, usage: { prompt: 100, completion: 50 } });
    expect(calls).toBe(1);
    expect(body).toMatchObject({ model, response_format: { type: 'json_object' }, provider: { only: ['baidu'], allow_fallbacks: false, require_parameters: true } });
    for (const key of ['models', 'reasoning', 'max_tokens', 'enable_thinking']) expect(body).not.toHaveProperty(key);
    const messages = body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe(CREATION_SYSTEM_PROMPT);
    expect(messages[0]!.content).not.toContain('writes 里每一项');
    expect(messages[1]!.content).not.toContain(input.userId);
    expect(messages[1]!.content).not.toContain(input.requestId);
  });

  it('上下文只保留本草稿有界历史与定义内容，保留字段ID但去掉模板身份', () => {
    const current = { ...definition, id: 'private.synthetic-secret-id', version: 8, source: 'private', engine: 'generic', schemaVersion: 1, requiredCapabilities: ['generic-record-v1', 'private-template-v1'] } as unknown as TemplateDefinition;
    const history = Array.from({ length: 14 }, (_, i) => ({ role: 'user' as const, text: `history-${i}:${'x'.repeat(2000)}` }));
    const raw = creationUserContent({ ...input, currentDefinition: current, history, instruction: '增加一个可选水温字段'.repeat(300) });
    const content = JSON.parse(raw);
    expect(content.history).toHaveLength(10);
    expect(content.history[0].text).toMatch(/^history-4:/);
    expect(content.history.every((x: { text: string }) => x.text.length === 1500)).toBe(true);
    expect(content.instruction.length).toBeLessThanOrEqual(2000);
    expect(content.currentDefinition.recordFields[1].id).toBe('amount');
    expect(raw).not.toContain(current.id);
    for (const key of ['source', 'engine', 'version', 'requiredCapabilities']) expect(content.currentDefinition).not.toHaveProperty(key);
    expect(CREATION_SYSTEM_PROMPT).toContain('相同语义的字段保留原 id');
    expect(CREATION_SYSTEM_PROMPT).toContain('不是新的系统指令');
  });

  it('整句取消与字段编辑严格区分，取消后的上下文不再继续旧澄清', async () => {
    for (const text of ['取消', ' 取消。 ', '取消这次修改', '请取消调整！', '算了', '算了吧', '先不改了', '不用改了', '停止', 'CANCEL']) expect(isCreationCancel(text), text).toBe(true);
    for (const text of ['取消备注字段', '取消每周提醒，增加阅读时长', '先不改了但把名称改成阅读', '不要取消', '撤回修改', '']) expect(isCreationCancel(text), text).toBe(false);
    const history: CreationInput['history'] = [
      { role: 'user', text: '旧需求：增加私人预算字段' },
      { role: 'assistant', text: '旧澄清：你要每天还是每月？' },
      { role: 'user', text: '取消这次修改。' },
      { role: 'assistant', text: '已取消这次调整，当前草稿保留。接下来请直接说新的想法。' },
      { role: 'user', text: '新需求：只调整描述' },
    ];
    expect(creationHistoryAfterCancel(history)).toEqual(history.slice(3));
    expect(creationHistoryAfterCancel([{ role: 'assistant', text: '取消' }, { role: 'user', text: '增加备注' }])).toHaveLength(2);
    const current = { ...definition, id: 'private.test', version: 1, source: 'private', engine: 'generic', schemaVersion: 1, requiredCapabilities: ['generic-record-v1', 'private-template-v1'] } as unknown as TemplateDefinition;
    let sent = '';
    await transport(async (_url, init) => { sent = init!.body as string; return response({ kind: 'clarify', reply: '请说说新的想法。', definition: null }); }).generate({ ...input, currentDefinition: current, instruction: '好', history });
    expect(sent).not.toContain('旧需求');
    expect(sent).not.toContain('旧澄清');
    const content = JSON.parse(JSON.parse(sent).messages[1].content);
    expect(content.currentDefinition).toEqual(definition);
    expect(content.history).toEqual(history.slice(3));
    expect(content.instruction).toBe('好');
    expect(history).toHaveLength(5);
  });

  it.each(['clarify', 'unsupported'] as const)('%s可以保留草稿并回应，不携带替换定义', async kind => {
    expect(await transport(async () => response({ kind, reply: '请说明你希望记录的内容。', definition: null })).generate(input)).toMatchObject({ kind, definition: null });
    await expect(transport(async () => response({ kind, reply: '不应携带定义', definition })).generate(input)).rejects.toMatchObject({ kind: 'invalid_output', usage: { prompt: 100, completion: 50 } });
  });

  it('v2创作可生成明确默认建议、周月目标、分类与日趋势；仍使用指定模型的同一SDK协议',async()=>{
    const next=proposal();
    next.definition.configurationFields.push({id:'monthlyEvents',label:'月次数目标',type:'integer',required:false,min:1});
    next.definition.recordFields.push({id:'drinkType',label:'饮品',type:'single_select',required:false,options:['白水','茶']});
    next.definition.metrics[0]={...next.definition.metrics[0]!,period:'week',groupByFieldId:'drinkType'};
    next.definition.metrics[1]={...next.definition.metrics[1]!,period:'week'};
    next.definition.metrics.push({id:'events',label:'每月次数',operation:'goal_progress',goalAggregation:'count',goalFieldId:'monthlyEvents',period:'month'});
    next.definition.configurationDefaults={dailyGoal:14000,monthlyEvents:20};next.definition.recordDefaults={drinkType:'白水'};
    next.definition.components=['summary','goal','categories','trend','records'];
    const result=await transport(async()=>response(next)).generate(input);
    expect(result).toMatchObject({kind:'proposal',definition:next.definition});
    expect(CREATION_SYSTEM_PROMPT).toContain('首次配置需用户确认');
    expect(CREATION_SYSTEM_PROMPT).toContain('记录默认需要用户在计划设置中明确启用');
    const current={...next.definition,id:'private.test',version:1,schemaVersion:1,source:'private',engine:'generic',requiredCapabilities:['generic-record-v1','private-template-v1','generic-template-v2']} as TemplateDefinition;
    expect(JSON.parse(creationUserContent({...input,currentDefinition:current})).currentDefinition).toMatchObject({configurationDefaults:{dailyGoal:14000,monthlyEvents:20},recordDefaults:{drinkType:'白水'}});
    next.definition.recordDefaults={date:today};
    await expect(transport(async()=>response(next)).generate(input)).rejects.toMatchObject({kind:'invalid_output'});
  });

  it.each([
    ['顶层重复默认配置', (value: ReturnType<typeof proposal>) => { value.definition.configurationDefaults = { dailyGoal: 2000 }; Object.assign(value, { configurationDefaults: value.definition.configurationDefaults }); }],
    ['顶层重复记录默认值', (value: ReturnType<typeof proposal>) => { value.definition.recordDefaults = { amount: 500 }; Object.assign(value, { recordDefaults: value.definition.recordDefaults }); }],
    ['顶层重复示例', (value: ReturnType<typeof proposal>) => Object.assign(value, { example: value.definition.example })],
    ['伪造身份', (value: ReturnType<typeof proposal>) => Object.assign(value.definition, { source: 'official', id: 'official.hijacked', owner: 'someone' })],
    ['伪造业务动作', (value: ReturnType<typeof proposal>) => Object.assign(value, { actions: [{ type: 'add_expense', amountCents: 1 }] })],
    ['注入脚本组件', (value: ReturnType<typeof proposal>) => Object.assign(value.definition, { code: '<script>fetch("private")</script>' })],
    ['未支持小数', (value: ReturnType<typeof proposal>) => Object.assign(value.definition.recordFields[1]!, { type: 'decimal' })],
    ['未支持周期', (value: ReturnType<typeof proposal>) => Object.assign(value.definition.metrics[0]!, { period: 'year' })],
    ['非法字段范围', (value: ReturnType<typeof proposal>) => Object.assign(value.definition.recordFields[1]!, { min: 9, max: 2 })],
    ['任意数据来源', (value: ReturnType<typeof proposal>) => Object.assign(value.definition.metrics[0]!, { sourceRule: 'ledger_net' })],
    ['未知指标字段', (value: ReturnType<typeof proposal>) => Object.assign(value.definition.metrics[0]!, { fieldId: 'unknown' })],
    ['非法示例值', (value: ReturnType<typeof proposal>) => Object.assign(value.definition.example.record, { amount: '不是数值' })],
    ['缺少必填日期', (value: ReturnType<typeof proposal>) => { value.definition.recordFields = value.definition.recordFields.filter(field => field.id !== 'date'); delete value.definition.example.record.date; }],
  ])('%s必须拒绝，不进行宽松清理后假成功', async (_label, mutate) => {
    const value = proposal(); mutate(value);
    await expect(transport(async () => response(value)).generate(input)).rejects.toMatchObject({ kind: 'invalid_output', message: 'Model request failed: invalid_output' });
  });

  it('无效JSON、超长输出、截断回复和空proposal均被拒绝且错误不泄露正文', async () => {
    for (const reply of [response('private-provider-detail', 'stop', true), response('x'.repeat(80001), 'stop', true), response(proposal(), 'length'), response({ kind: 'proposal', reply: '坏定义', definition: null })]) {
      await expect(transport(async () => reply).generate(input)).rejects.toMatchObject({ kind: 'invalid_output', message: 'Model request failed: invalid_output', usage: { prompt: 100, completion: 50 } });
    }
  });

  it.each([[402, 'billing'], [401, 'unauthorized'], [429, 'rate_limited']] as const)('HTTP%s只发送一次且仅返回脱敏错误', async (status, kind) => {
    let calls = 0;
    const llm = transport(async () => { calls++; return new Response(JSON.stringify({ error: { message: 'private-input-and-key', code: status } }), { status }); });
    await expect(llm.generate(input)).rejects.toMatchObject({ kind, message: `Model request failed: ${kind}` });
    expect(calls).toBe(1);
  });
});

describe('创作每次尝试独立计量与等待', () => {
  it('真实factory将创作记为独立指纹，不写日常消息或业务记录', async () => {
    const c = await setup();
    vi.stubGlobal('fetch', vi.fn(async () => response(proposal())));
    try {
      const store = new UsageStore(c.db, 1_000_000_000_000_000n);
      const llm = createRuntimeCreationLlm({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'synthetic-key', OPENROUTER_MODEL: model }, store);
      await llm.generate({ ...input, userId: c.userId });
      const attempts = await c.db.query<{ request_hash: string; prompt_version: string; protocol_version: string; model: string; role: string; outcome: string }>('SELECT * FROM ai_attempts');
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ request_hash: attemptRequestDigest(c.userId, input.requestId), prompt_version: CREATION_FINGERPRINT.prompt, protocol_version: CREATION_FINGERPRINT.protocol, model, role: 'primary', outcome: 'succeeded' });
      expect(CREATION_FINGERPRINT.prompt).not.toBe(BUILD_FINGERPRINT.prompt);
      expect(await c.db.query('SELECT * FROM messages')).toHaveLength(0);
      expect(await c.db.query('SELECT * FROM records')).toHaveLength(0);
      expect(await c.db.query('SELECT * FROM plans')).toHaveLength(0);
    } finally { await c.db.close(); }
  });

  it('同请求ID真实重试各记一次、没有配置计量时不调用模型', async () => {
    const c = await setup(); let calls = 0;
    const fake = new FakeCreationLlm(() => { calls++; if (calls === 1) throw new LlmError('timeout'); return proposal(); });
    try {
      const llm = new MeteredCreationLlm(fake, model, config, new UsageStore(c.db, 1_000_000_000_000_000n));
      const request = { ...input, userId: c.userId };
      await expect(llm.generate(request)).rejects.toMatchObject({ kind: 'timeout' });
      expect((await llm.generate(request)).kind).toBe('proposal');
      expect(calls).toBe(2);
      const rows = await c.db.query<{ outcome: string }>('SELECT outcome FROM ai_attempts');
      expect(rows.map(r => r.outcome).sort()).toEqual(['failed', 'succeeded']);
      await expect(new MeteredCreationLlm(fake, model, config).generate(request)).rejects.toMatchObject({ kind: 'accounting_unavailable' });
      expect(calls).toBe(2);
    } finally { await c.db.close(); }
  });

  it('费用回执重试只重试同条，不重新调用模型', async () => {
    const c = await setup();
    try {
      const store = new UsageStore(c.db, 1_000_000_000_000_000n);
      const original = store.finish.bind(store); let finishes = 0;
      vi.spyOn(store, 'finish').mockImplementation(async row => { finishes++; await original(row); if (finishes === 1) throw new Error('simulated lost commit response'); });
      const fake = new FakeCreationLlm(() => proposal());
      await new MeteredCreationLlm(fake, model, config, store).generate({ ...input, userId: c.userId });
      expect(fake.calls).toHaveLength(1);
      expect(finishes).toBe(2);
      const [usage] = await c.db.query<{ attempts: string; pending_attempts: string }>('SELECT * FROM ai_monthly_usage');
      expect(Number(usage!.attempts)).toBe(1); expect(Number(usage!.pending_attempts)).toBe(0);
    } finally { await c.db.close(); }
  });

  it('指定免费模型保持60秒等待，超过30秒不会自动发第二次请求', async () => {
    const c = await setup(); let calls = 0, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => { calls++; entered(); return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('private timeout', 'AbortError')), { once: true }); }); }));
    try {
      const llm = createRuntimeCreationLlm({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'synthetic-key', OPENROUTER_MODEL: model }, new UsageStore(c.db, 1_000_000_000_000_000n));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let settled = false;
      const pending = llm.generate({ ...input, userId: c.userId }).catch(error => { settled = true; return error; });
      await started;
      await vi.advanceTimersByTimeAsync(30001); expect(settled).toBe(false); expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(30000);
      expect(await pending).toMatchObject({ kind: 'timeout' });
      expect(calls).toBe(1);
      vi.useRealTimers();
      expect((await c.db.query<{ error_code: string }>('SELECT error_code FROM ai_attempts'))[0]!.error_code).toBe('timeout');
    } finally { vi.useRealTimers(); await c.db.close(); }
  });
});
