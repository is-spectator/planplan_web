import { CREATION_SYSTEM_PROMPT, creationUserContent } from '../src/ai/creation.js';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiModelProfile, aiProviderConfig, assertApplicationModelAllowed } from '../src/ai/provider.js';
import { OpenAICompatibleLlm } from '../src/ai/llm.js';
import { OpenAICompatibleCreationLlm, createRuntimeCreationLlm } from '../src/ai/creation-runtime.js';
import { createRuntimeLlm } from '../src/ai/runtime.js';
import type { Db } from '../src/db/db.js';
import { UsageStore } from '../src/ai/usage-store.js';
import * as runtimeConfig from '../src/ai/runtime-config.js';
import baseline from './fixtures/candidate-wire-baseline.json' with { type: 'json' };

const lightning = 'nvidia/nemotron-3.5-lightning:free';
const superVl = 'nvidia/nemotron-3.5-super-vl:free';
const baidu = 'baidu/ernie-5.5-flash-preview:free';
const input = { userId: 'synthetic-user', requestId: 'synthetic-request', today: '2026-11-17', instruction: '创建一个合成测试模板', currentDefinition: null, history: [] };
const response = (value: unknown, raw = false, finish = 'stop') => new Response(JSON.stringify({
  choices: [{ message: { role: 'assistant', content: raw ? value : JSON.stringify(value) }, finish_reason: finish }],
  usage: { prompt_tokens: 12, completion_tokens: 6 },
}), { headers: { 'content-type': 'application/json' } });
const successChat = () => response({ intent: 'smalltalk', reply: '合成回复' });
const successCreation = () => response({ kind: 'clarify', reply: '请说明合成模板。', definition: null });
const chat = (model: string, fetch: typeof globalThis.fetch, mode: 'compact' | 'strict' = 'compact') => new OpenAICompatibleLlm('synthetic-key', 'https://fixture.test/v1', model, mode, 100, { provider: 'openrouter', fetch });
const creation = (model: string, fetch: typeof globalThis.fetch) => new OpenAICompatibleCreationLlm({ apiKey: 'synthetic-key', baseURL: 'https://fixture.test/v1', model, provider: 'openrouter', timeoutMs: 100, fetch });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('候选模型仅经合成适配器显式选择，无真实网络请求', () => {
  it('默认仍为百度；显式配置候选不会改成备用列表', () => {
    expect(aiProviderConfig({ AI_PROVIDER: 'openrouter' }).model).toBe(baidu);
    for (const model of [lightning, superVl]) expect(aiProviderConfig({ AI_PROVIDER: 'openrouter', OPENROUTER_MODEL: model })).toMatchObject({ model, mode: 'compact' });
  });

  it('Lightning strict 配置必须明确拒绝，不降级 compact', () => {
    expect(() => aiProviderConfig({ AI_PROVIDER: 'openrouter', OPENROUTER_MODEL: lightning, OPENROUTER_OUTPUT: 'strict' })).toThrow(/does not support.*strict/i);
  });

  it('直接构造 Lightning strict 也必须在任何请求前拒绝', () => {
    const fetch = vi.fn(async () => successChat());
    expect(() => chat(lightning, fetch, 'strict')).toThrow(/does not support.*strict/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([lightning, superVl])('正常聊天 factory 拒绝 synthetic-only %s，伪造 env 开关也不能启用', model => {
    const fetch = vi.fn(async () => successChat()); vi.stubGlobal('fetch', fetch);
    const usage = vi.spyOn(UsageStore.prototype, 'start');
    const db = new Proxy({}, { get() { throw new Error('Database must not be accessed'); } }) as Db;
    expect(() => createRuntimeLlm(db, { AI_PROVIDER: 'openrouter', OPENROUTER_MODEL: model, OPENROUTER_API_KEY: 'synthetic-key', AI_ALLOW_SYNTHETIC_MODEL: 'true' })).toThrow(/synthetic evaluation only/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
  });

  it.each([lightning, superVl])('正常创作 factory 拒绝 synthetic-only %s，不能静默当作用户模型', model => {
    const fetch = vi.fn(async () => successCreation()); vi.stubGlobal('fetch', fetch);
    const usage = vi.spyOn(UsageStore.prototype, 'start');
    expect(() => createRuntimeCreationLlm({ AI_PROVIDER: 'openrouter', OPENROUTER_MODEL: model, OPENROUTER_API_KEY: 'synthetic-key', AI_ALLOW_SYNTHETIC_MODEL: 'true' })).toThrow(/synthetic evaluation only/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
  });

  it.each(['chat', 'creation'] as const)('Lightning %s compact 省略 response_format，保持本地验证和单 NVIDIA 路由', async kind => {
    let body: Record<string, unknown> = {}; let calls = 0;
    const fetch: typeof globalThis.fetch = async (_url, init) => { calls++; body = JSON.parse(init!.body as string); return kind === 'chat' ? successChat() : successCreation(); };
    if (kind === 'chat') expect((await chat(lightning, fetch).plan('synthetic system', 'synthetic user')).turn.reply).toBe('合成回复');
    else expect(await creation(lightning, fetch).generate(input)).toMatchObject({ kind: 'clarify', definition: null });
    expect(calls).toBe(1);
    expect(body).toMatchObject({ model: lightning, provider: { only: ['nvidia'], allow_fallbacks: false, require_parameters: true } });
    expect(body.reasoning).toEqual({ enabled: false });
    for (const key of ['response_format', 'models', 'enable_thinking', 'max_tokens']) expect(body).not.toHaveProperty(key);
  });

  it.each(['compact', 'strict'] as const)('SuperVL %s 保留相应结构化格式且只指定 NVIDIA', async mode => {
    let body: Record<string, unknown> = {};
    await chat(superVl, async (_url, init) => { body = JSON.parse(init!.body as string); return successChat(); }, mode).plan('synthetic system', 'synthetic user');
    expect(body.response_format).toMatchObject(mode === 'compact' ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: 'turn', strict: true } });
    expect(body.provider).toEqual({ only: ['nvidia'], allow_fallbacks: false, require_parameters: true });
    expect(body.reasoning).toEqual({ enabled: false });
  });

  it('SuperVL 创作保留 json_object 和独立创作校验', async () => {
    let body: Record<string, unknown> = {};
    await creation(superVl, async (_url, init) => { body = JSON.parse(init!.body as string); return successCreation(); }).generate(input);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.provider).toEqual({ only: ['nvidia'], allow_fallbacks: false, require_parameters: true });
    expect(body.reasoning).toEqual({ enabled: false });
  });

  it('付费 Lightning 与 Qwen 同名模型不被免费 OpenRouter 特例影响', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return successChat(); };
    await chat(lightning.replace(':free', ''), fetch, 'strict').plan('synthetic system', 'synthetic user');
    await new OpenAICompatibleLlm('synthetic-key', 'https://fixture.test/v1', lightning, 'strict', 100, { provider: 'qwen', fetch }).plan('synthetic system', 'synthetic user');
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body.response_format).toMatchObject({ type: 'json_schema' });
    expect(bodies[0]!.provider).toEqual({ allow_fallbacks: false, require_parameters: true });
    expect(bodies[1]).not.toHaveProperty('provider');
    for (const body of bodies) expect(body).not.toHaveProperty('reasoning');
  });

  it.each([lightning, superVl])('%s profile不可变，应用限制不接受大小写/空白/provider标签绕过', model => {
    const expected = { syntheticOnly: true, providerOnly: ['nvidia'], reasoning: { enabled: false } };
    const fetch = vi.fn(async () => successChat()); vi.stubGlobal('fetch', fetch);
    const usage = vi.spyOn(UsageStore.prototype, 'start');
    for (const alias of [model, `  ${model}\t`, model.toUpperCase()]) {
      const profile = aiModelProfile('openrouter', alias);
      expect(profile).toMatchObject(expected);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.providerOnly)).toBe(true);
      expect(Object.isFrozen(profile.reasoning)).toBe(true);
      for (const provider of ['openrouter', 'qwen'] as const) {
        expect(() => assertApplicationModelAllowed(provider, alias)).toThrow(/synthetic evaluation only/i);
        const env = provider === 'openrouter'
          ? { AI_PROVIDER: provider, OPENROUTER_MODEL: alias, OPENROUTER_BASE_URL: 'https://fixture.test/v1', OPENROUTER_API_KEY: 'synthetic-key' }
          : { AI_PROVIDER: provider, QWEN_MODEL: alias, QWEN_BASE_URL: 'https://fixture.test/v1', QWEN_API_KEY: 'synthetic-key' };
        expect(() => createRuntimeLlm({} as Db, env)).toThrow(/synthetic evaluation only/i);
        expect(() => createRuntimeCreationLlm(env)).toThrow(/synthetic evaluation only/i);
      }
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
  });

  it('Lightning strict的拼写变体同样拒绝，付费版本不泛化封禁', () => {
    expect(() => chat(` ${lightning.toUpperCase()} `, async () => successChat(), 'strict')).toThrow(/does not support.*strict/i);
    for (const model of [lightning, superVl].map(model => model.replace(':free', ''))) {
      expect(aiModelProfile('openrouter', model)).toMatchObject({ syntheticOnly: false, supportsResponseFormat: true });
      expect(() => assertApplicationModelAllowed('openrouter', model)).not.toThrow();
    }
  });

  it.each([lightning, superVl])('既有审核后的备用配置也不能把 %s 引入用户请求', model => {
    // Isolate the post-review factory boundary; report approval itself has its own regression tests.
    vi.spyOn(runtimeConfig, 'loadRuntimeConfig').mockReturnValue({ monthlyBudgetCny: '1000', timeoutMs: 20000, attemptRetentionDays: 30, pricing: null, fallback: { model, primaryReport: 'synthetic-primary', fallbackReport: 'synthetic-backup' } });
    const fetch = vi.fn(async () => successChat()); vi.stubGlobal('fetch', fetch);
    const usage = vi.spyOn(UsageStore.prototype, 'start');
    expect(() => createRuntimeLlm({} as Db, { QWEN_API_KEY: 'synthetic-key', QWEN_BASE_URL: 'https://fixture.test/v1' })).toThrow(/synthetic evaluation only/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
  });

  it.each([
    ['普通文本', '不是 JSON'],
    ['围栏', '```json\n{"intent":"smalltalk","reply":"你好"}\n```'],
    ['数组', '[]'],
    ['未知动作', JSON.stringify({ intent: 'write', writes: [{ op: 'drop_database', is_fact: true }] })],
    ['混入坏动作', JSON.stringify({ intent: 'write', writes: [{ op: 'add_expense', is_fact: true, amount_text: '1元' }, { op: 'unknown', is_fact: true }] })],
    ['泛型缺少事实标识', JSON.stringify({ intent: 'write', writes: [{ op: 'add_generic_record', generic_fields: [] }] })],
    ['小聊携带写入', JSON.stringify({ intent: 'smalltalk', writes: [{ op: 'delete_record', is_fact: true, record_id: 'synthetic-record' }] })],
    ['未知查询', JSON.stringify({ intent: 'query', query: { kind: 'arbitrary_query' } })],
  ])('Lightning 非结构化传输仍拒绝%s，不提取或部分采用', async (_label, value) => {
    let calls = 0;
    await expect(chat(lightning, async () => { calls++; return response(value, true); }).plan('synthetic system', 'synthetic user')).rejects.toMatchObject({ kind: 'invalid_output', usage: { prompt: 12, completion: 6 } });
    expect(calls).toBe(1);
  });

  it.each([
    ['普通文本', '不是 JSON'],
    ['围栏', '```json\n{"kind":"clarify","reply":"你好","definition":null}\n```'],
    ['数组', '[]'],
    ['无定义 proposal', JSON.stringify({ kind: 'proposal', reply: '你好', definition: null })],
    ['未知顶层字段', JSON.stringify({ kind: 'clarify', reply: '你好', definition: null, arbitrary: true })],
  ])('Lightning 创作保留 strict schema，拒绝%s', async (_label, value) => {
    let calls = 0;
    await expect(creation(lightning, async () => { calls++; return response(value, true); }).generate(input)).rejects.toMatchObject({ kind: 'invalid_output', usage: { prompt: 12, completion: 6 } });
    expect(calls).toBe(1);
  });

  it.each(['chat', 'creation'] as const)('%s 截断输出拒绝且不自动重发模型', async kind => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls++; return response(kind === 'chat' ? { intent: 'smalltalk', reply: '合成' } : { kind: 'clarify', reply: '合成', definition: null }, false, 'length'); };
    await expect(kind === 'chat' ? chat(lightning, fetch).plan('', '') : creation(lightning, fetch).generate(input)).rejects.toMatchObject({ kind: 'invalid_output' });
    expect(calls).toBe(1);
  });

  it.each(['chat', 'creation'] as const)('%s 429仅一个请求，不更换模型或供应商', async kind => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message: 'synthetic-private-detail' } }), { status: 429 }); };
    await expect(kind === 'chat' ? chat(lightning, fetch).plan('', '') : creation(lightning, fetch).generate(input)).rejects.toMatchObject({ kind: 'rate_limited', message: 'Model request failed: rate_limited' });
    expect(calls).toBe(1);
  });
});

describe('既有默认请求字节不变：原始实现预先捕获的 SHA-256', () => {
  it.each(['qwen', 'openrouter'] as const)('%s compact/strict 消息、顺序和参数均保持原字节', async provider => {
    for (const mode of ['compact', 'strict'] as const) {
      let body = '';
      await new OpenAICompatibleLlm('synthetic-key', 'https://fixture.test/v1', provider === 'qwen' ? 'qwen3.8-max' : baidu, mode, 100, { provider, fetch: async (_url, init) => { body = init!.body as string; return successChat(); } }).plan('synthetic system', 'synthetic user');
      expect(createHash('sha256').update(body).digest('hex')).toBe(baseline[`${provider}-chat-${mode}`]);
    }
  });
  it('百度创作采用当前创作提示，传输参数保持原契约', async () => {
    let body = '';
    await creation(baidu, async (_url, init) => { body = init!.body as string; return successCreation(); }).generate(input);
    expect(JSON.parse(body)).toEqual({model:baidu,messages:[{role:'system',content:CREATION_SYSTEM_PROMPT},{role:'user',content:creationUserContent(input)}],temperature:0.1,response_format:{type:'json_object'},provider:{only:['baidu'],allow_fallbacks:false,require_parameters:true}});
  });
});
