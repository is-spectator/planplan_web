import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeLlm, LlmError, QwenLlm, type Llm, type LlmResult } from '../src/ai/llm.js';
import { sanitizeTurn } from '../src/ai/turn.js';
import { MeteredLlm } from '../src/ai/runtime.js';
import { UsageStore, attemptRequestDigest } from '../src/ai/usage-store.js';
import { BUILD_FINGERPRINT, assertEvaluationReport, loadRuntimeConfig, type PriceBook, type RuntimeConfig } from '../src/ai/runtime-config.js';
import { formatPico, priceAttempt } from '../src/ai/cost.js';
import { Chat } from '../src/services/chat.js';
import { requestAccountDeletion } from '../src/services/deletion.js';
import { setup } from './helpers.js';
import { CASES } from '../evals/cases.js';
import { evaluationMetadata } from '../evals/metadata.js';

const NOW = new Date('2026-10-27T08:00:00+08:00');
const usage = { prompt: 100, completion: 20, cachedPrompt: 0 };
// 仅用于确定性测试的合成价格，不能作为部署价目。
const book: PriceBook = { version: 'synthetic-test-prices', sourceURL: 'https://example.test/test-only', verifiedAt: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z', models: Object.fromEntries(['test-primary', 'test-backup'].map((model) => [model, [{ maxPromptTokens: 2_000_000, inputCnyPerMillion: '1', outputCnyPerMillion: '2', cacheMode: 'reported' as const, cachedInputCnyPerMillion: '0.25' }]])) };
const config = (patch: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ monthlyBudgetCny: '1000', timeoutMs: 20000, attemptRetentionDays: 30, pricing: book, fallback: null, ...patch });
const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function result(write = false): Promise<LlmResult> {
  const llm = new FakeLlm(() => sanitizeTurn(write ? { intent: 'write', writes: [{ op: 'add_expense', amount_text: '20', category: '餐饮', note: '午饭' }] } : { intent: 'smalltalk', reply: '你好' })!);
  return { ...await llm.plan('', ''), usage };
}
async function ledger() {
  const c = await setup();
  await c.run(NOW.toISOString(), { type: 'create_ledger' });
  return c;
}
const primary = (llm: Llm) => ({ model: 'test-primary', llm });
const backup = (llm: Llm) => ({ model: 'test-backup', llm });
const monthly = async (db: Awaited<ReturnType<typeof setup>>['db']) => (await db.query<{ attempts: string | number; pending_attempts: string | number; unknown_cost_attempts: string | number; known_cost_pico: string }>('SELECT * FROM ai_monthly_usage'))[0]!;

describe('主备模型只在理解阶段切换，每次真实尝试独立记账', () => {
  it('主非法输出、备用成功只写入一次；已保存结果重放不增加调用或费用', async () => {
    const c = await ledger(); let calls = 0;
    const good = await result(true);
    const llm = new MeteredLlm(c.db,
      primary({ plan: async () => { calls++; throw new LlmError('invalid_output', 'must not leak secret', usage); } }),
      backup({ plan: async () => { calls++; return good; } }), config(), 'compact', () => NOW);
    const chat = new Chat(c.db, llm);
    const input = { clientMsgId: 'same-request', text: '午饭20元', inputAt: NOW };
    const first = await chat.send(c.userId, input);
    expect(first.transient).toBe(false);
    expect((await c.db.query('SELECT id FROM records')).length).toBe(1);
    expect((await chat.send(c.userId, input)).assistant.id).toBe(first.assistant.id);
    expect(calls).toBe(2);
    const attempts = await c.db.query<{ role: string; error_code: string; prompt_tokens: number; cost_status: string; prompt_version: string; protocol_version: string }>('SELECT * FROM ai_attempts ORDER BY role');
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.cost_status === 'known' && a.prompt_version === BUILD_FINGERPRINT.prompt && a.protocol_version === BUILD_FINGERPRINT.protocol)).toBe(true);
    expect(attempts.find((a) => a.role === 'primary')!.error_code).toBe('invalid_output');
    expect(Number((await monthly(c.db)).attempts)).toBe(2);
    expect(BigInt((await monthly(c.db)).known_cost_pico)).toBe(280_000_000n);
  });
  it('双失败不写业务；相同 clientMsgId 再试的真实调用不能被费用去重吃掉', async () => {
    const c = await ledger(); let calls = 0;
    const good = await result(true);
    const llm = new MeteredLlm(c.db, primary({ plan: async () => { calls++; if (calls === 1) throw new LlmError('timeout'); return good; } }), backup({ plan: async () => { calls++; throw new LlmError('unavailable', '', usage); } }), config(), 'compact', () => NOW);
    const chat = new Chat(c.db, llm), input = { clientMsgId: 'retry-real-attempt', text: '午饭20元', inputAt: NOW };
    expect((await chat.send(c.userId, input)).transient).toBe(true);
    expect(await c.db.query('SELECT id FROM records')).toHaveLength(0);
    expect((await chat.send(c.userId, input)).transient).toBe(false);
    expect(calls).toBe(3);
    expect(await c.db.query('SELECT attempt_id FROM ai_attempts')).toHaveLength(3);
    const total = await monthly(c.db);
    expect(Number(total.attempts)).toBe(3);
    expect(Number(total.unknown_cost_attempts)).toBe(1);
    expect(BigInt(total.known_cost_pico)).toBe(280_000_000n);
  });
  it.each(['billing', 'unauthorized'] as const)('%s 不能假称同账户备用可恢复', async (kind) => {
    const c = await setup(); let backupCalls = 0;
    const llm = new MeteredLlm(c.db, primary({ plan: async () => { throw new LlmError(kind, 'raw-private-message'); } }), backup({ plan: async () => { backupCalls++; return result(); } }), config(), 'compact', () => NOW);
    await expect(llm.plan('', '', { userId: c.userId, requestId: 'blocked' })).rejects.toMatchObject({ kind });
    expect(backupCalls).toBe(0);
    expect(JSON.stringify(await c.db.query('SELECT * FROM ai_attempts'))).not.toContain('raw-private-message');
  });
  it('没有备用配置只调用主模型一次，实际并发重复调用各记一笔', async () => {
    const c = await setup(); let calls = 0;
    const good = await result();
    const llm = new MeteredLlm(c.db, primary({ plan: async () => { calls++; return good; } }), null, config(), 'compact', () => NOW);
    await Promise.all([llm.plan('', '', { userId: c.userId, requestId: 'concurrent' }), llm.plan('', '', { userId: c.userId, requestId: 'concurrent' })]);
    expect(calls).toBe(2);
    expect(await c.db.query('SELECT DISTINCT attempt_id FROM ai_attempts')).toHaveLength(2);
    expect(Number((await monthly(c.db)).attempts)).toBe(2);
  });
  it('客户端请求标识可能含原文，计费明细只保存可关联摘要', async () => {
    const c = await setup(), good = await result();
    const llm = new MeteredLlm(c.db, primary({ plan: async () => good }), null, config(), 'compact', () => NOW);
    const requestId = 'private-message-as-client-id:午饭花了20元';
    await llm.plan('', '', { userId: c.userId, requestId });
    const rows = await c.db.query<{ request_hash: string }>('SELECT * FROM ai_attempts');
    expect(rows[0]!.request_hash).toBe(attemptRequestDigest(c.userId, requestId));
    expect(JSON.stringify(rows)).not.toContain(requestId);
    expect(attemptRequestDigest(c.userId, requestId)).not.toBe(attemptRequestDigest(randomUUID(), requestId));
  });
});

describe('费用账本与告警不影响预算外调用', () => {
  it('1000元月度阈值只告警，第三次仍调用；金额精确、同月去重告警', async () => {
    const c = await setup(); let calls = 0;
    const costlyBook: PriceBook = { ...book, models: { 'test-primary': [{ maxPromptTokens: 2_000_000, inputCnyPerMillion: '600', outputCnyPerMillion: '0', cacheMode: 'none' }] } };
    const good = { ...await result(), usage: { prompt: 1_000_000, completion: 0 } };
    const llm = new MeteredLlm(c.db, primary({ plan: async () => { calls++; return good; } }), null, config({ pricing: costlyBook }), 'compact', () => NOW);
    for (let i = 0; i < 3; i++) await llm.plan('', '', { userId: c.userId, requestId: `budget-${i}` });
    expect(calls).toBe(3);
    expect(formatPico(BigInt((await monthly(c.db)).known_cost_pico))).toBe('1800');
    const events = await c.db.query<{ props: { policy: string } }>(`SELECT props FROM events WHERE name='model_budget_exceeded'`);
    expect(events).toHaveLength(1); expect(events[0]!.props.policy).toBe('alert_only');
  });
  it('usage 缺失和未配置价格明确未知并各自告警，不伪装成零费用', async () => {
    const c = await setup(), good = await result();
    for (const [index, settings] of [{ usage: null, pricing: book }, { usage, pricing: null }].entries()) {
      const llm = new MeteredLlm(c.db, primary({ plan: async () => ({ ...good, usage: settings.usage }) }), null, config({ pricing: settings.pricing }), 'compact', () => NOW);
      await llm.plan('', '', { userId: c.userId, requestId: `unknown-${index}` });
    }
    const rows = await c.db.query<{ cost_status: string; cost_pico: string | null }>('SELECT cost_status,cost_pico FROM ai_attempts');
    expect(rows.map((r) => r.cost_status).sort()).toEqual(['unpriced', 'usage_missing']);
    expect(rows.every((r) => r.cost_pico === null)).toBe(true);
    expect(Number((await monthly(c.db)).unknown_cost_attempts)).toBe(2);
    expect(await c.db.query(`SELECT name FROM events WHERE name='model_cost_unknown'`)).toHaveLength(2);
  });
  it('同 attempt UUID 的持久化重试只累计一次；中断调用保留未知并告警', async () => {
    const c = await setup(), store = new UsageStore(c.db, 1_000_000_000_000_000n), attemptId = randomUUID();
    const start = { userId: c.userId, requestId: 'receipt', attemptId, at: NOW, role: 'primary' as const, model: 'test-primary', mode: 'compact' as const, priceVersion: book.version };
    await store.start(start); await store.start(start);
    const finish = { attemptId, error: null, usage, latencyMs: 12, cost: priceAttempt('test-primary', usage, book, NOW) };
    await Promise.all([store.finish(finish), store.finish(finish)]);
    expect(Number((await monthly(c.db)).attempts)).toBe(1);
    expect(BigInt((await monthly(c.db)).known_cost_pico)).toBe(140_000_000n);
    await store.start({ ...start, attemptId: randomUUID() });
    await store.alertStale(new Date(NOW.getTime() + 600_000));
    await store.alertStale(new Date(NOW.getTime() + 600_000));
    expect(Number((await monthly(c.db)).unknown_cost_attempts)).toBe(1);
    expect(Number((await monthly(c.db)).pending_attempts)).toBe(1);
    expect(await c.db.query(`SELECT props FROM events WHERE props->>'reason'='pending_attempt'`)).toHaveLength(1);
  });
  it('账户删除清除关联明细，保留匿名月额，在途调用完成仍入账', async () => {
    const c = await setup(), good = await result();
    let complete!: (r: LlmResult) => void, started!: () => void;
    const reachedProvider = new Promise<void>((resolve) => { started = resolve; });
    const llm = new MeteredLlm(c.db, primary({ plan: () => new Promise((resolve) => { complete = resolve; started(); }) }), null, config(), 'compact', () => NOW);
    const pending = llm.plan('', '', { userId: c.userId, requestId: 'in-flight-delete' });
    await reachedProvider;
    expect((await requestAccountDeletion(c.db, c.userId)).status).toBe('completed');
    expect(await c.db.query('SELECT * FROM ai_attempts')).toHaveLength(0);
    complete(good); await pending;
    expect(BigInt((await monthly(c.db)).known_cost_pico)).toBe(140_000_000n);
    expect(Number((await monthly(c.db)).attempts)).toBe(1);
    expect(await c.db.query('SELECT * FROM ai_attempts')).toHaveLength(0);
    expect(JSON.stringify(await c.db.query('SELECT * FROM ai_usage_receipts'))).not.toContain(c.userId);
  });
  it('缓存和价目有效期不完整时不计算假金额', () => {
    expect(priceAttempt('test-primary', { prompt: 100, completion: 20 }, book, NOW).status).toBe('cache_usage_unknown');
    expect(priceAttempt('test-primary', usage, book, new Date('2028-01-01')).status).toBe('price_expired');
    expect(priceAttempt('test-primary', { prompt: 100, completion: 20, cachedPrompt: 40 }, book, NOW).pico).toBe(110_000_000n);
    expect(priceAttempt('missing-model', usage, book, NOW).status).toBe('unpriced');
  });
  it('个人调用明细按配置到期清理，匿名费用与未完成凭据不丢失', async () => {
    const c = await setup(), good = await result();
    const llm = new MeteredLlm(c.db, primary({ plan: async () => good }), null, config(), 'compact', () => NOW);
    await llm.plan('', '', { userId: c.userId, requestId: 'retention' });
    await llm.usageStore.pruneDetails(new Date(NOW.getTime() + 29 * 86400_000), 30);
    expect(await c.db.query('SELECT * FROM ai_attempts')).toHaveLength(1);
    await llm.usageStore.pruneDetails(new Date(NOW.getTime() + 31 * 86400_000), 30);
    expect(await c.db.query('SELECT * FROM ai_attempts')).toHaveLength(0);
    expect(BigInt((await monthly(c.db)).known_cost_pico)).toBe(140_000_000n);
    expect(await c.db.query('SELECT * FROM ai_usage_receipts')).toHaveLength(1);
  });
});

const QUERY_TOTAL = CASES.filter((c) => c.expect.kind === 'query').length;
function report(model = 'test-primary') {
  return { metadata: { ...evaluationMetadata(model, 'compact', 10_000, 'synthetic-test'), review: { version: 'synthetic-only', status: 'approved', productReviewer: 'synthetic-test-product', testReviewer: 'synthetic-test-reviewer', reviewedAt: '2026-01-01T00:00:00Z' } }, gates: { passed: true, keyRate: 1, oneTurnRate: 1, wrongWrites: 0, queryPassed: QUERY_TOTAL, queryTotal: QUERY_TOTAL }, results: BUILD_FINGERPRINT.caseIds.map((id) => ({ id, pass: true, executedOneTurn: true, wrongFactWrites: 0 })) };
}
describe('备用模型必须同套全量评测审定', () => {
  it('拒绝草稿、子集、旧prompt/协议/模式和门槛失败', () => {
    expect(() => assertEvaluationReport(report(), 'test-primary', 'compact')).not.toThrow();
    const draft = report(); draft.metadata.review.status = 'draft';
    const subset = report(); subset.results.pop();
    const oldPrompt = report(); oldPrompt.metadata.runtime.prompt = 'old';
    const oldDataset = report(); oldDataset.metadata.dataset = 'old-three-file-fingerprint';
    const failed = report(); failed.gates.passed = false;
    const duplicate = report(); duplicate.results[0] = duplicate.results[1]!;
    const inconsistent = report(); inconsistent.results.find((x) => x.id === 'Q001')!.pass = false;
    for (const bad of [draft, subset, oldPrompt, oldDataset, failed, duplicate, inconsistent]) expect(() => assertEvaluationReport(bad, 'test-primary', 'compact')).toThrow();
    expect(() => assertEvaluationReport(report(), 'test-primary', 'strict')).toThrow();
    expect(() => assertEvaluationReport(report(), 'other-model', 'compact')).toThrow();
    expect(() => assertEvaluationReport(report(), 'test-primary', 'compact', 5000)).toThrow();
  });
  it('无配置保留单模型+1000元只告警；备用配置须引用两份真实匹配报告', () => {
    expect(loadRuntimeConfig({}, 'test-primary', 'compact')).toMatchObject({ monthlyBudgetCny: '1000', fallback: null, pricing: null });
    const dir = mkdtempSync(join(tmpdir(), 'ai-runtime-review-')); dirs.push(dir);
    writeFileSync(join(dir, 'primary.json'), JSON.stringify(report()));
    writeFileSync(join(dir, 'backup.json'), JSON.stringify(report('test-backup')));
    const path = join(dir, 'runtime.json');
    writeFileSync(path, JSON.stringify({ fallback: { model: 'test-backup', primaryReport: 'primary.json', fallbackReport: 'backup.json' } }));
    expect(loadRuntimeConfig({ AI_RUNTIME_CONFIG_PATH: path }, 'test-primary', 'compact').fallback?.model).toBe('test-backup');
    const draft = report('test-backup'); draft.metadata.review.status = 'draft';
    writeFileSync(join(dir, 'backup.json'), JSON.stringify(draft));
    expect(() => loadRuntimeConfig({ AI_RUNTIME_CONFIG_PATH: path }, 'test-primary', 'compact')).toThrow('actual product and test review');
  });
});

describe('Qwen 传输与无效输出保留费用证据', () => {
  const response = (content: string, extras = {}) => new Response(JSON.stringify({ id: 'synthetic', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } }, ...extras }), { status: 200, headers: { 'content-type': 'application/json' } });
  it('SDK 500 不隐藏重试，错误原文不会传播', async () => {
    let calls = 0;
    const llm = new QwenLlm('synthetic-key', 'https://example.test/v1', 'test-primary', 'compact', 100, { fetch: async () => { calls++; return new Response(JSON.stringify({ error: { code: 'InternalError', message: 'private-user-text-and-secret' } }), { status: 500 }); } });
    await expect(llm.plan('', '')).rejects.toMatchObject({ kind: 'unavailable', message: 'Model request failed: unavailable' });
    expect(calls).toBe(1);
  });
  it('即使环境开启SDK调试，原文和密钥也不会进入SDK日志', async () => {
    vi.stubEnv('OPENAI_LOG', 'debug');
    const logs = (['debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const llm = new QwenLlm('synthetic-private-key', 'https://example.test/v1', 'test-primary', 'compact', 100, { fetch: async () => response('not json') });
      await expect(llm.plan('private system', 'private user')).rejects.toMatchObject({ kind: 'invalid_output' });
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally { for (const log of logs) log.mockRestore(); vi.unstubAllEnvs(); }
  });
  it.each(['not json', '{}', '{"intent":"made_up"}', '{"intent":"write","writes":[{"op":"unknown"}]}', '{"intent":"smalltalk","writes":[{"op":"add_expense","amount_text":"20"}]}', '{"intent":"query","query":{"kind":"made_up"}}'])('非法结构保留已知 token：%s', async (content) => {
    const llm = new QwenLlm('synthetic-key', 'https://example.test/v1', 'test-primary', 'compact', 100, { fetch: async () => response(content) });
    await expect(llm.plan('', '')).rejects.toMatchObject({ kind: 'invalid_output', usage });
  });
  it('Arrearage 和权限错误按结构化 code 分类，不检查可能含隐私的 message', async () => {
    const llm = new QwenLlm('synthetic-key', 'https://example.test/v1', 'test-primary', 'compact', 100, { fetch: async () => new Response(JSON.stringify({ error: { code: 'Arrearage', message: 'private raw provider message' } }), { status: 403 }) });
    await expect(llm.plan('', '')).rejects.toMatchObject({ kind: 'billing' });
  });
  it('真正的 SDK 超时保持 timeout 枚举且不暗中重试', async () => {
    let calls = 0;
    const llm = new QwenLlm('synthetic-key', 'https://example.test/v1', 'test-primary', 'compact', 20, { fetch: async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new DOMException('synthetic timeout', 'AbortError'));
        if (init?.signal?.aborted) fail(); else init?.signal?.addEventListener('abort', fail, { once: true });
      });
    } });
    await expect(llm.plan('', '')).rejects.toMatchObject({ kind: 'timeout', usage: null });
    expect(calls).toBe(1);
  });
  it('供应商错误中的部分已知 token 仍保留，不填补未知用量', async () => {
    const llm = new QwenLlm('synthetic-key', 'https://example.test/v1', 'test-primary', 'compact', 100, { fetch: async () => new Response(JSON.stringify({ error: { code: 'InternalError', message: 'private', usage: { prompt_tokens: 42 } } }), { status: 500 }) });
    await expect(llm.plan('', '')).rejects.toMatchObject({ kind: 'unavailable', usage: { prompt: 42, completion: null, cachedPrompt: null } });
  });
});
