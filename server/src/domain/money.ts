/** 金额全程用“分”的整数表示。 */
export const MAX_EXPENSE_CENTS = 99_999_999; // ¥999,999.99

export function isValidCents(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_EXPENSE_CENTS;
}

/** ¥1,290 / ¥25.50 / −¥50（负数用真正的减号） */
export function formatYuan(cents: number, opts: { alwaysDecimals?: boolean } = {}): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  const intPart = yuan.toLocaleString('en-US');
  const dec = fen === 0 && !opts.alwaysDecimals ? '' : `.${String(fen).padStart(2, '0')}`;
  return `${neg ? '−' : ''}¥${intPart}${dec}`;
}

/** 由用户可读的金额字符串得到分；最多两位小数。 */
export function parseYuanToCents(input: string): number | null {
  const s = input.trim().replace(/[¥￥,，\s]/g, '').replace(/元|块$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [i, d = ''] = s.split('.');
  return Number(i) * 100 + Number(d.padEnd(2, '0'));
}

/** 使用率，四舍五入到整数百分比。 */
export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}
