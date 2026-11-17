import { type BizDate, type WeekKey, addDays, isoWeekday, weekDays, weekOf } from './time.js';

export const MAX_MINUTES_PER_DAY = 1440;

export function isValidMinutes(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_MINUTES_PER_DAY;
}

export function isValidDaysPerWeek(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 7;
}

/** 首周可执行天数：从开始日期到当周周日（含）。 */
export function firstWeekAvailableDays(planStart: BizDate): number {
  return 8 - isoWeekday(planStart);
}

/** 某周的目标天数。首周取标准目标与首周可执行天数的较小值。 */
export function weekTargetDays(planStart: BizDate, week: WeekKey, daysPerWeek: number | null): number | null {
  if (daysPerWeek === null) return null;
  const startWeek = weekOf(planStart);
  if (week < startWeek) return null;
  if (week === startWeek) return Math.min(daysPerWeek, firstWeekAvailableDays(planStart));
  return daysPerWeek;
}

export type DayStatus = 'future' | 'before_start' | 'none' | 'recorded' | 'below' | 'met';

export interface StudyDay {
  date: BizDate;
  minutes: number;
  sessions: number;
  status: DayStatus;
}

export interface StudyWeekStats {
  week: WeekKey;
  daysPerWeek: number | null;
  minMinutes: number | null;
  goalComplete: boolean;
  targetDays: number | null;
  metDays: number | null;
  exceededDays: number | null;
  recordDays: number;
  totalMinutes: number;
  interrupted: boolean;
  days: StudyDay[];
}

export function studyWeekStats(args: {
  week: WeekKey;
  planStart: BizDate;
  today: BizDate;
  records: { date: BizDate; minutes: number; sessions?: number }[];
  daysPerWeek: number | null;
  minMinutes: number | null;
  interrupted: boolean;
}): StudyWeekStats {
  const { week, planStart, today, records, daysPerWeek, minMinutes, interrupted } = args;
  const goalComplete = daysPerWeek !== null && minMinutes !== null;
  const evaluated = goalComplete && !interrupted;
  const byDay = new Map<BizDate, { minutes: number; sessions: number }>();
  for (const r of records) {
    if (weekOf(r.date) !== week) continue;
    const d = byDay.get(r.date) ?? { minutes: 0, sessions: 0 };
    d.minutes += r.minutes;
    d.sessions += r.sessions ?? 1;
    byDay.set(r.date, d);
  }
  const days: StudyDay[] = weekDays(week).map((date) => {
    const d = byDay.get(date) ?? { minutes: 0, sessions: 0 };
    let status: DayStatus;
    if (date > today) status = d.minutes > 0 ? 'recorded' : 'future';
    else if (date < planStart) status = d.minutes > 0 ? 'recorded' : 'before_start';
    else if (d.minutes === 0) status = 'none';
    else if (!evaluated) status = 'recorded';
    else status = d.minutes >= (minMinutes as number) ? 'met' : 'below';
    return { date, minutes: d.minutes, sessions: d.sessions, status };
  });
  const recordDays = days.filter((d) => d.minutes > 0).length;
  const totalMinutes = days.reduce((s, d) => s + d.minutes, 0);
  const targetDays = goalComplete ? weekTargetDays(planStart, week, daysPerWeek) : null;
  const metDays = evaluated ? days.filter((d) => d.status === 'met').length : null;
  return {
    week,
    daysPerWeek,
    minMinutes,
    goalComplete,
    targetDays,
    metDays,
    exceededDays: metDays !== null && targetDays !== null ? Math.max(0, metDays - targetDays) : null,
    recordDays,
    totalMinutes,
    interrupted,
    days,
  };
}

/**
 * 执行中断周：发生归档或恢复的周，以及整段处在“归档 → 恢复”区间里的周（尚未恢复则一直到现在）。
 * 依据的是生命周期区间，而不是计划当前的状态。
 */
export function isInterruptedWeek(week: WeekKey, events: { event: 'archived' | 'restored'; on_date: BizDate }[]): boolean {
  let archivedFrom: WeekKey | null = null;
  for (const e of events) {
    const w = weekOf(e.on_date);
    if (w === week) return true;
    if (e.event === 'archived') archivedFrom = archivedFrom ?? w;
    else if (archivedFrom !== null) {
      if (week >= archivedFrom && week <= w) return true;
      archivedFrom = null;
    }
  }
  return archivedFrom !== null && week >= archivedFrom;
}

export function dayTotal(records: { date: BizDate; minutes: number }[], date: BizDate): number {
  return records.filter((r) => r.date === date).reduce((s, r) => s + r.minutes, 0);
}

export { addDays };
