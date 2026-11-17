import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.js';
import { DomainError } from '../services/errors.js';
import { classifyLlmError, LlmError, OpenAICompatibleLlm, type Llm, type LlmContext, type LlmResult } from './llm.js';
import { aiProviderConfig, assertApplicationModelAllowed, recoveryTimeoutMs } from './provider.js';
import { decimalUnits, loadRuntimeConfig, type RuntimeConfig } from './runtime-config.js';
import { priceAttempt } from './cost.js';
import { UsageStore } from './usage-store.js';

export interface ModelTarget { model: string; llm: Llm }

/** 路由只负责理解阶段。最终 Turn 返回后才由 Chat 执行业务写入，写入失败绝不触发模型重试。 */
export class MeteredLlm implements Llm {
  readonly usageStore: UsageStore;
  constructor(db: Db, private readonly primary: ModelTarget, private readonly fallback: ModelTarget | null, private readonly config: RuntimeConfig,
    private readonly mode: 'compact' | 'strict' = 'compact', private readonly now: () => Date = () => new Date()) {
    this.usageStore = new UsageStore(db, decimalUnits(config.monthlyBudgetCny, 12));
  }

  async plan(system: string, user: string, context?: LlmContext): Promise<LlmResult> {
    if (!context) throw new LlmError('accounting_unavailable');
    const targets = [this.primary, ...(this.fallback ? [this.fallback] : [])];
    for (const [index, target] of targets.entries()) {
      const at = this.now(), attemptId = randomUUID();
      try {
        await this.usageStore.start({ ...context, attemptId, at, model: target.model, role: index ? 'fallback' : 'primary', mode: this.mode, priceVersion: this.config.pricing?.version ?? null });
      } catch (e) {
        if (e instanceof DomainError) throw e;
        throw new LlmError('accounting_unavailable');
      }
      const started = Date.now();
      let result: LlmResult | undefined;
      let error: LlmError | undefined;
      try { result = await target.llm.plan(system, user, context); }
      catch (e) { error = e instanceof LlmError ? e : new LlmError(classifyLlmError(e)); }
      const usage = result?.usage ?? error?.usage ?? null;
      const finish = { attemptId, latencyMs: Date.now() - started, error: error?.kind ?? null, usage, cost: priceAttempt(target.model, usage, this.config.pricing, at) };
      try { await this.usageStore.finish(finish); }
      catch {
        // 数据库结果未知时只重试同一个 receipt；不重发模型请求、不重复累计。
        try { await this.usageStore.finish(finish); }
        catch { console.warn('model_usage_persistence_failed'); throw new LlmError('accounting_unavailable'); }
      }
      if (result) return result;
      if (index || !this.fallback || !['timeout', 'unavailable', 'invalid_output', 'rate_limited'].includes(error!.kind)) throw error!;
    }
    throw new LlmError('unavailable');
  }

  async maintain(): Promise<void> {
    await this.usageStore.alertStale(this.now());
    await this.usageStore.pruneDetails(this.now(), this.config.attemptRetentionDays);
  }
}

export function createRuntimeLlm(db: Db, env: NodeJS.ProcessEnv): MeteredLlm {
  const { provider, model, baseURL, mode, apiKeyVariable } = aiProviderConfig(env);
  assertApplicationModelAllowed(provider, model);
  const apiKey = env[apiKeyVariable];
  if (!apiKey?.trim()) throw new Error(`Missing ${apiKeyVariable}`);
  const config = loadRuntimeConfig(env, model, mode);
  const extendedTimeoutMs=recoveryTimeoutMs(env,provider,model);
  if(extendedTimeoutMs!==undefined&&config.fallback)throw new Error('OpenRouter free requests cannot use fallback models');
  const requestTimeoutMs = Math.floor(config.timeoutMs / (config.fallback ? 2 : 1));
  const target = (name: string): ModelTarget => {
    assertApplicationModelAllowed(provider, name);
    return { model: name, llm: new OpenAICompatibleLlm(apiKey, baseURL, name, mode, requestTimeoutMs, { provider, recoveryTimeoutMs:extendedTimeoutMs }) };
  };
  return new MeteredLlm(db, target(model), config.fallback ? target(config.fallback.model) : null, config, mode);
}
