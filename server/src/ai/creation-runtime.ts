import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { CREATION_SYSTEM_PROMPT, creationResponseSchema, creationUserContent, type CreationInput, type CreationLlm, type CreationResult } from './creation.js';
import { classifyLlmError, LlmError, responseUsage, type LlmResult } from './llm.js';
import { aiModelProfile, aiProviderConfig, assertApplicationModelAllowed, recoveryTimeoutMs, type AiModelProfile, type AiProvider } from './provider.js';
import { loadRuntimeConfig, type RuntimeConfig } from './runtime-config.js';
import { priceAttempt } from './cost.js';
import { UsageStore } from './usage-store.js';
import { DomainError } from '../services/errors.js';
import fingerprint from './creation-build-fingerprint.json' with { type: 'json' };

export const CREATION_FINGERPRINT = fingerprint;

/** Separate protocol: the record-chat Turn schema and action parser are never used. */
export class OpenAICompatibleCreationLlm implements CreationLlm {
  private readonly client: OpenAI;
  private readonly profile: AiModelProfile;
  constructor(private readonly options: { apiKey: string; baseURL: string; model: string; provider: AiProvider; timeoutMs: number; fetch?: typeof fetch }) {
    this.profile = aiModelProfile(options.provider, options.model);
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL, timeout: options.timeoutMs, maxRetries: 0, logLevel: 'off', ...(options.fetch ? { fetch: options.fetch } : {}) });
  }

  async generate(input: CreationInput): Promise<CreationResult> {
    const started = Date.now();
    let content: string | null | undefined;
    let usage: LlmResult['usage'] = null;
    try {
      const response = await this.client.chat.completions.create({
        model: this.options.model,
        messages: [{ role: 'system', content: CREATION_SYSTEM_PROMPT }, { role: 'user', content: creationUserContent(input) }],
        temperature: 0.1,
        ...(this.profile.supportsResponseFormat ? { response_format: { type: 'json_object' } } : {}),
        ...(this.profile.reasoning ? { reasoning: this.profile.reasoning } : {}),
        ...(this.options.provider === 'qwen' ? { enable_thinking: false } : { provider: { ...(this.profile.providerOnly ? { only: this.profile.providerOnly } : {}), allow_fallbacks: false, require_parameters: true } }),
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
      content = response.choices[0]?.message?.content;
      usage = responseUsage(response.usage);
      if (response.choices[0]?.finish_reason === 'length') throw new LlmError('invalid_output', '', usage);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const raw = error as { error?: { usage?: unknown }; usage?: unknown };
      throw new LlmError(classifyLlmError(error), '', responseUsage(raw?.usage ?? raw?.error?.usage));
    }
    try {
      if (!content || content.length > 80_000) throw new Error('Invalid size');
      return { ...creationResponseSchema.parse(JSON.parse(content)), latencyMs: Date.now() - started, usage };
    } catch {
      throw new LlmError('invalid_output', '', usage);
    }
  }
}

/** Exactly one accounted provider attempt; failures never select a different model. */
export class MeteredCreationLlm implements CreationLlm {
  constructor(private readonly inner: CreationLlm, private readonly model: string, private readonly config: RuntimeConfig,
    readonly usageStore?: UsageStore, private readonly now: () => Date = () => new Date()) {}

  async generate(input: CreationInput): Promise<CreationResult> {
    if (!this.usageStore) throw new LlmError('accounting_unavailable');
    const at = this.now(), attemptId = randomUUID();
    try {
      await this.usageStore.start({ userId: input.userId, requestId: input.requestId, attemptId, at, model: this.model, role: 'primary', mode: 'compact', priceVersion: this.config.pricing?.version ?? null, promptVersion: CREATION_FINGERPRINT.prompt, protocolVersion: CREATION_FINGERPRINT.protocol });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new LlmError('accounting_unavailable');
    }
    const started = Date.now();
    let result: CreationResult | undefined;
    let error: LlmError | undefined;
    try { result = await this.inner.generate(input); }
    catch (failure) { error = failure instanceof LlmError ? failure : new LlmError(classifyLlmError(failure)); }
    const usage = result?.usage ?? error?.usage ?? null;
    const finish = { attemptId, latencyMs: Date.now() - started, error: error?.kind ?? null, usage, cost: priceAttempt(this.model, usage, this.config.pricing, at) };
    try { await this.usageStore.finish(finish); }
    catch {
      // Retry only the same accounting receipt, never the model request.
      try { await this.usageStore.finish(finish); }
      catch { console.warn('creation_usage_persistence_failed'); throw new LlmError('accounting_unavailable'); }
    }
    if (result) return result;
    throw error!;
  }
}

export function createRuntimeCreationLlm(env: NodeJS.ProcessEnv, usageStore?: UsageStore): MeteredCreationLlm {
  const { provider, model, baseURL, apiKeyVariable } = aiProviderConfig(env);
  assertApplicationModelAllowed(provider, model);
  const apiKey = env[apiKeyVariable];
  if (!apiKey?.trim()) throw new Error(`Missing ${apiKeyVariable}`);
  const config = loadRuntimeConfig(env, model, 'compact');
  if (config.fallback) throw new Error('Template creation cannot use fallback models');
  const timeoutMs = recoveryTimeoutMs(env, provider, model) ?? config.timeoutMs;
  return new MeteredCreationLlm(new OpenAICompatibleCreationLlm({ apiKey, baseURL, model, provider, timeoutMs }), model, config, usageStore);
}
