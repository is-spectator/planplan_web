import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import fingerprint from './build-fingerprint.json' with { type: 'json' };

export const BUILD_FINGERPRINT = { prompt: fingerprint.prompt, protocol: fingerprint.protocol, dataset: fingerprint.dataset, caseIds: fingerprint.caseIds, caseCount: fingerprint.caseIds.length };
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/);
const positiveInteger = z.number().int().positive().max(1_000_000_000);
const priceBand = z.object({ maxPromptTokens: positiveInteger, inputCnyPerMillion: decimal, outputCnyPerMillion: decimal, cacheMode: z.enum(['none', 'reported']), cachedInputCnyPerMillion: decimal.optional() }).strict();
export const priceBookSchema = z.object({
  version: z.string().trim().min(1).max(100),
  sourceURL: z.url().refine((s) => s.startsWith('https://')),
  verifiedAt: z.iso.datetime(),
  validUntil: z.iso.datetime(),
  models: z.record(z.string().min(1), z.array(priceBand).min(1)),
}).strict();
export type PriceBook = z.infer<typeof priceBookSchema>;
const configSchema = z.object({
  monthlyBudgetCny: decimal.default('1000'),
  // iOS请求25秒；给两次模型调用合计最多20秒，留出统计/保存时间。
  timeoutMs: z.number().int().min(100).max(20_000).default(20_000),
  attemptRetentionDays: z.number().int().min(1).max(30).default(30),
  pricing: priceBookSchema.nullable().default(null),
  fallback: z.object({ model: z.string().trim().min(1).max(100), primaryReport: z.string().min(1), fallbackReport: z.string().min(1) }).strict().nullable().default(null),
}).strict();
export type RuntimeConfig = z.infer<typeof configSchema>;

/** 计费以 pico-CNY (10^-12 元) 整数存储。每百万 token 的六位小数价格恰好可转成每 token 整数。 */
export function decimalUnits(value: string, decimals: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}

export function assertEvaluationReport(raw: unknown, model: string, outputMode: string, requestTimeoutMs = 10_000): void {
  const r = raw as { metadata?: { model?: string; dataset?: string; runtime?: typeof BUILD_FINGERPRINT & { outputMode?: string; requestTimeoutMs?: number }; review?: { version?: string; status?: string; productReviewer?: string; testReviewer?: string; reviewedAt?: string } }; gates?: { passed?: boolean; keyRate?: number; oneTurnRate?: number; wrongWrites?: number; queryPassed?: number; queryTotal?: number }; results?: { id: string; pass: boolean; executedOneTurn: boolean; wrongFactWrites: number }[] };
  const m = r?.metadata, v = m?.runtime, review = m?.review, g = r?.gates;
  const validIds = (ids: string[] | undefined) => !!ids && ids.length === fingerprint.caseIds.length && [...ids].sort().every((id, i) => id === fingerprint.caseIds[i]);
  if (m?.model !== model || m.dataset !== fingerprint.dataset || v?.prompt !== fingerprint.prompt || v.protocol !== fingerprint.protocol || v.dataset !== fingerprint.dataset || v.outputMode !== outputMode || v.requestTimeoutMs !== requestTimeoutMs || v.caseCount !== fingerprint.caseIds.length || !validIds(v.caseIds) || !validIds(r.results?.map((x) => x.id))) throw new Error('Fallback evaluation does not match this full dataset, model, mode, timeout, prompt and protocol build');
  if (review?.status !== 'approved' || !review.version?.trim() || !review.productReviewer?.trim() || !review.testReviewer?.trim() || !review.reviewedAt || !Number.isFinite(Date.parse(review.reviewedAt)) || Date.parse(review.reviewedAt) > Date.now()) throw new Error('Fallback evaluation requires actual product and test review');
  if (!g?.passed || !(g.keyRate! >= 0.98) || !(g.oneTurnRate! >= 0.9) || g.wrongWrites !== 0 || !g.queryTotal || g.queryPassed !== g.queryTotal) throw new Error('Fallback evaluation gates did not pass');
  // 不仅相信 passed 标记：按当前构建的案例定义复核机器结果，拒绝相互矛盾/缺字段的报告。
  const results = r.results!;
  const rules = fingerprint.caseRules as Record<string, { kind: string; clear: boolean }>;
  if (results.some((x) => typeof x.pass !== 'boolean' || typeof x.executedOneTurn !== 'boolean' || !Number.isSafeInteger(x.wrongFactWrites) || x.wrongFactWrites < 0)) throw new Error('Evaluation results are incomplete');
  const key = results.filter((x) => ['records', 'plan', 'goal', 'edit', 'delete', 'undo', 'plan_update'].includes(rules[x.id]!.kind));
  const clear = results.filter((x) => rules[x.id]!.clear);
  const guard = results.filter((x) => ['no_write', 'clarify', 'query'].includes(rules[x.id]!.kind));
  const queries = results.filter((x) => rules[x.id]!.kind === 'query');
  const keyRate = key.filter((x) => x.pass).length / key.length, oneTurnRate = clear.filter((x) => x.pass && x.executedOneTurn).length / clear.length;
  if (!key.length || !clear.length || !guard.every((x) => x.pass && x.wrongFactWrites === 0) || keyRate < 0.98 || oneTurnRate < 0.9 || g.keyRate !== keyRate || g.oneTurnRate !== oneTurnRate || g.queryTotal !== queries.length || g.queryPassed !== queries.filter((x) => x.pass).length) throw new Error('Evaluation gates disagree with case results');
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv, primaryModel: string, outputMode: string): RuntimeConfig {
  const path = env.AI_RUNTIME_CONFIG_PATH;
  const config = configSchema.parse(path ? JSON.parse(readFileSync(path, 'utf8')) : {});
  if (decimalUnits(config.monthlyBudgetCny, 12) <= 0n) throw new Error('Monthly AI budget must be positive (alert only)');
  if (config.pricing) {
    if (Date.parse(config.pricing.validUntil) <= Date.parse(config.pricing.verifiedAt)) throw new Error('Price book validity is invalid');
    for (const bands of Object.values(config.pricing.models)) if (bands.some((b, i) => i > 0 && b.maxPromptTokens <= bands[i - 1]!.maxPromptTokens)) throw new Error('Price bands must have increasing prompt-token limits');
  }
  if (config.fallback) {
    if (config.fallback.model === primaryModel) throw new Error('Fallback model must differ from primary');
    for (const [model, report] of [[primaryModel, config.fallback.primaryReport], [config.fallback.model, config.fallback.fallbackReport]]) {
      assertEvaluationReport(JSON.parse(readFileSync(resolve(dirname(path!), report!), 'utf8')), model!, outputMode, Math.floor(config.timeoutMs / 2));
    }
  }
  return config;
}
