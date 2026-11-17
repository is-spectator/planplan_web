import type { LlmResult } from './llm.js';
import { decimalUnits, type PriceBook } from './runtime-config.js';

export type CostStatus = 'known' | 'usage_missing' | 'unpriced' | 'price_expired' | 'cache_usage_unknown' | 'cache_unpriced';
export interface AttemptCost { status: CostStatus; pico: bigint | null; priceVersion: string | null }
const tokens = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** 仅用已核实价目和供应商用量算费用；缺项不以零代替。免费额度/账单折扣仍须与供应商对账。 */
export function priceAttempt(model: string, usage: LlmResult['usage'], book: PriceBook | null, now: Date): AttemptCost {
  const unknown = (status: CostStatus): AttemptCost => ({ status, pico: null, priceVersion: book?.version ?? null });
  if (!usage || !tokens(usage.prompt) || !tokens(usage.completion)) return unknown('usage_missing');
  if (!book || !book.models[model]) return unknown('unpriced');
  if (now.getTime() < Date.parse(book.verifiedAt) || now.getTime() > Date.parse(book.validUntil)) return unknown('price_expired');
  const band = book.models[model]!.find((b) => usage.prompt! <= b.maxPromptTokens);
  if (!band) return unknown('unpriced');
  let cached = usage.cachedPrompt;
  if (cached !== undefined && cached !== null && !tokens(cached)) return unknown('cache_usage_unknown');
  if (band.cacheMode === 'none') {
    if (cached && cached > 0) return unknown('cache_unpriced');
    cached = 0;
  } else if (!tokens(cached) || cached > usage.prompt) return unknown('cache_usage_unknown');
  if (cached! > 0 && band.cachedInputCnyPerMillion === undefined) return unknown('cache_unpriced');
  const rate = (s: string) => decimalUnits(s, 6); // 元/百万 token -> pico元/token，精确整数。
  const pico = BigInt(usage.prompt - cached!) * rate(band.inputCnyPerMillion)
    + BigInt(cached!) * rate(band.cachedInputCnyPerMillion ?? '0')
    + BigInt(usage.completion) * rate(band.outputCnyPerMillion);
  return { status: 'known', pico, priceVersion: book.version };
}

export function formatPico(pico: bigint): string {
  const decimals = (pico % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
  return `${pico / 1_000_000_000_000n}${decimals ? '.' + decimals : ''}`;
}
