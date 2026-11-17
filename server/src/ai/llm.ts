import OpenAI from 'openai';
import { TURN_JSON_SCHEMA, sanitizeTurn, type Turn } from './turn.js';
import { aiModelProfile, assertOutputModeSupported, type AiModelProfile, type AiProvider } from './provider.js';

export interface LlmResult {
  turn: Turn;
  latencyMs: number;
  usage: { prompt: number | null; completion: number | null; cachedPrompt?: number | null } | null;
}

export interface LlmContext { userId: string; requestId: string; recoveryCapable?:boolean }
export interface Llm {
  plan(system: string, user: string, context?: LlmContext): Promise<LlmResult>;
}

export type LlmErrorKind = 'unavailable' | 'invalid_output' | 'timeout' | 'billing' | 'unauthorized' | 'rate_limited' | 'invalid_request' | 'accounting_unavailable';
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    _legacyMessage = '',
    readonly usage: LlmResult['usage'] = null,
  ) {
    // 原始供应商消息可能含请求内容或凭据，绝不穿过服务边界/日志。
    super(`Model request failed: ${kind}`);
  }
}

function token(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
export function responseUsage(raw: unknown): LlmResult['usage'] {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const details = r.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  return { prompt: token(r.prompt_tokens), completion: token(r.completion_tokens), cachedPrompt: token(details?.cached_tokens) };
}

export function classifyLlmError(error: unknown): LlmErrorKind {
  if (error instanceof LlmError) return error.kind;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';
  const e = error as { code?: unknown; status?: number; error?: { code?: unknown } } | null;
  const code = typeof e?.code === 'string' ? e.code : typeof e?.error?.code === 'string' ? e.error.code : '';
  if (/arrearage|insufficient[_\.]?(balance|quota)|out_of_service|billing|credit_balance/i.test(code)) return 'billing';
  if (e?.status === 402) return 'billing';
  if (e?.status === 401 || e?.status === 403 || /invalidapi.?key|accessdenied|permission|unauthorized|forbidden/i.test(code)) return 'unauthorized';
  if (e?.status === 429) return 'rate_limited';
  if (e?.status && e.status >= 400 && e.status < 500) return 'invalid_request';
  return 'unavailable';
}

function validModelTurn(raw: unknown): Turn | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!['write', 'query', 'write_and_query', 'smalltalk', 'unsupported', 'answer_pending', 'cancel_pending'].includes(r.intent as string)) return null;
  if (r.writes !== undefined && !Array.isArray(r.writes)) return null;
  if (r.query !== undefined && r.query !== null) {
    if (typeof r.query !== 'object' || Array.isArray(r.query) || !['ledger_summary', 'ledger_category', 'budget', 'study_progress', 'generic_summary', 'overview'].includes((r.query as { kind?: string }).kind ?? '')) return null;
  }
  const turn = sanitizeTurn(raw);
  if (!turn || (Array.isArray(r.writes) && turn.writes.length !== r.writes.length)) return null;
  if (['write', 'write_and_query'].includes(turn.intent) && !turn.writes.length) return null;
  if (['query', 'write_and_query'].includes(turn.intent) && !turn.query) return null;
  if (['smalltalk', 'unsupported', 'cancel_pending'].includes(turn.intent) && (turn.writes.length || turn.query)) return null;
  if (turn.intent === 'query' && turn.writes.length) return null;
  if (turn.intent === 'write' && turn.query) return null;
  return turn;
}

/**
 * 紧凑输出：只写有值的字段。实测比严格 JSON Schema 快一倍以上（约 3 秒对 7 秒），
 * 输出仍经过 sanitizeTurn 逐字段校验，缺省字段取安全默认值。
 */
export const COMPACT_FORMAT = `

## 输出格式
只输出一个 JSON 对象，不要任何其他文字。writes 里每一项只写有值的字段：op 和 is_fact 必写，值为 null 的字段省略。
顶层结构：{"intent":"...","writes":[{"op":"...","is_fact":true,...}],"query":null 或查询对象,"missing":[],"question":null,"unsupported_kind":"none","reply":""}
字段与取值范围：${JSON.stringify(TURN_JSON_SCHEMA)}`;

/** Shared Chat Completions transport; provider extensions never cross providers. */
export class OpenAICompatibleLlm implements Llm {
  private readonly client: OpenAI;
  private readonly provider: AiProvider;
  private readonly profile: AiModelProfile;
  private readonly recoveryTimeoutMs?:number;
  constructor(
    apiKey: string,
    baseURL: string,
    private readonly model: string,
    private readonly mode: 'compact' | 'strict' = 'compact',
    timeoutMs = 20000,
    options: { fetch?: typeof fetch; provider?: AiProvider; recoveryTimeoutMs?:number } = {},
  ) {
    this.provider = options.provider ?? 'qwen';
    assertOutputModeSupported(this.provider, model, mode);
    this.profile = aiModelProfile(this.provider, model);
    this.recoveryTimeoutMs=options.recoveryTimeoutMs;
    // 每个网络 attempt 必须由外层单独记账，SDK 不得暗中重试。
    this.client = new OpenAI({ apiKey, baseURL, timeout: timeoutMs, ...(options.fetch ? { fetch: options.fetch } : {}), maxRetries: 0, logLevel: 'off' });
  }

  async plan(system: string, user: string, context?:LlmContext): Promise<LlmResult> {
    const started = Date.now();
    let content: string | null | undefined;
    let usage: LlmResult['usage'] = null;
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: this.mode === 'compact' ? system + COMPACT_FORMAT : system },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        ...(this.profile.supportsResponseFormat ? { response_format: this.mode === 'compact' ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: 'turn', strict: true, schema: TURN_JSON_SCHEMA } } } : {}),
        ...(this.profile.reasoning ? { reasoning: this.profile.reasoning } : {}),
        ...(this.provider === 'qwen'
          ? { enable_thinking: false }
          : {
              provider: { ...(this.profile.providerOnly ? { only: this.profile.providerOnly } : {}), allow_fallbacks: false, require_parameters: true },
            }),
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, context?.recoveryCapable && this.provider==='openrouter' && this.model.endsWith(':free') && this.recoveryTimeoutMs!==undefined ? {timeout:this.recoveryTimeoutMs}:undefined);
      content = res.choices[0]?.message?.content;
      usage = responseUsage(res.usage);
      if (res.choices[0]?.finish_reason === 'length') throw new LlmError('invalid_output', '', usage);
    } catch (e) {
      if (e instanceof LlmError) throw e;
      const body = e as { error?: { usage?: unknown }; usage?: unknown };
      throw new LlmError(classifyLlmError(e), '', responseUsage(body?.usage ?? body?.error?.usage));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content ?? '');
    } catch {
      throw new LlmError('invalid_output', '', usage);
    }
    const turn = validModelTurn(parsed);
    if (!turn) throw new LlmError('invalid_output', '', usage);
    return { turn, latencyMs: Date.now() - started, usage };
  }
}

/** Backwards-compatible constructor for existing Qwen integrations and tests. */
export class QwenLlm extends OpenAICompatibleLlm {}

/** 测试用：按顺序返回预设的回合，或根据输入动态生成。 */
export class FakeLlm implements Llm {
  readonly calls: { system: string; user: string }[] = [];
  constructor(private readonly responder: (user: string, system: string) => Partial<Turn> | Error) {}
  async plan(system: string, user: string): Promise<LlmResult> {
    this.calls.push({ system, user });
    const out = this.responder(user, system);
    if (out instanceof Error) throw out;
    const turn = sanitizeTurn({ intent: 'smalltalk', writes: [], query: null, missing: [], question: null, unsupported_kind: 'none', reply: '', ...out });
    return { turn: turn!, latencyMs: 1, usage: null };
  }
}
