/**
 * 业务时间：V1 固定 Asia/Shanghai（UTC+8，无夏令时）。
 * 日期一律用 'YYYY-MM-DD' 字符串表示业务日，月份用 'YYYY-MM'，周用该周周一的日期。
 */
export const TIMEZONE = 'Asia/Shanghai';
const OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 86400 * 1000;

export type BizDate = string; // YYYY-MM-DD
export type MonthKey = string; // YYYY-MM
export type WeekKey = string; // 周一的 YYYY-MM-DD

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function isBizDate(s: unknown): s is BizDate {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isMonthKey(s: unknown): s is MonthKey {
  return typeof s === 'string' && MONTH_RE.test(s) && isBizDate(`${s}-01`);
}

/** 某个时间点在上海的业务日期。 */
export function shanghaiDate(instant: Date): BizDate {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** 某个时间点在上海的时:分。 */
export function shanghaiTime(instant: Date): string {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(11, 16);
}

function toUTC(date: BizDate): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function addDays(date: BizDate, n: number): BizDate {
  return new Date(toUTC(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/** b - a 的天数。 */
export function diffDays(a: BizDate, b: BizDate): number {
  return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
}

/** 1 = 周一 … 7 = 周日 */
export function isoWeekday(date: BizDate): number {
  const d = new Date(toUTC(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

export function weekOf(date: BizDate): WeekKey {
  return addDays(date, 1 - isoWeekday(date));
}

export function weekEnd(week: WeekKey): BizDate {
  return addDays(week, 6);
}

export function weekDays(week: WeekKey): BizDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(week, i));
}

export function monthOf(date: BizDate): MonthKey {
  return date.slice(0, 7);
}

export function monthStart(month: MonthKey): BizDate {
  return `${month}-01`;
}

export function monthEnd(month: MonthKey): BizDate {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

export function nextMonth(month: MonthKey): MonthKey {
  return monthOf(addDays(monthEnd(month), 1));
}

export function prevMonth(month: MonthKey): MonthKey {
  return monthOf(addDays(monthStart(month), -1));
}

export function nextWeek(week: WeekKey): WeekKey {
  return addDays(week, 7);
}

export function prevWeek(week: WeekKey): WeekKey {
  return addDays(week, -7);
}

export function monthDays(month: MonthKey): BizDate[] {
  const out: BizDate[] = [];
  for (let d = monthStart(month); d <= monthEnd(month); d = addDays(d, 1)) out.push(d);
  return out;
}

const WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日'];
export function weekdayCN(date: BizDate): string {
  return `周${WEEKDAY_CN[isoWeekday(date) - 1]}`;
}

/** “10月26日” */
export function formatMonthDay(date: BizDate): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

/**
 * 解析模型给出的日期表达。相对表达一律按输入时刻（inputAt）的上海日期换算，
 * 这样离线消息跨天上传时，“今天”仍然是用户输入那天。
 */
export type DateExpr =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'day_before_yesterday' }
  | { kind: 'days_ago'; days: number }
  | { kind: 'absolute'; date: string }
  | { kind: 'unknown' };

export function resolveDateExpr(expr: DateExpr, inputAt: Date): BizDate | null {
  const today = shanghaiDate(inputAt);
  switch (expr.kind) {
    case 'today':
      return today;
    case 'yesterday':
      return addDays(today, -1);
    case 'day_before_yesterday':
      return addDays(today, -2);
    case 'days_ago':
      return Number.isInteger(expr.days) && expr.days >= 0 && expr.days <= 366 ? addDays(today, -expr.days) : null;
    case 'absolute':
      return isBizDate(expr.date) ? expr.date : null;
    default:
      return null;
  }
}
