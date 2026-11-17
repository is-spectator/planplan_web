/**
 * 目标规则的版本化。
 * 每次修改生成一个“规则段”：[fromPeriod, toPeriod]（toPeriod 为空表示一直生效）。
 * 某个周期的取值 = 覆盖该周期、且创建顺序最晚的那一段。
 * 这样三种生效范围都只是“新增一段”，历史周期永远不会被改写。
 */
export type GoalParam = 'budget_cents' | 'days_per_week' | 'min_minutes';
export type ChangeScope = 'current_only' | 'current_and_future' | 'next_and_future';

export interface RuleSegment {
  param: GoalParam;
  value: number;
  fromPeriod: string;
  toPeriod: string | null;
  seq: number;
  /** A later explicit clearing masks earlier values without destroying their history. */
  cleared?: boolean;
}

export function covers(seg: RuleSegment, period: string): boolean {
  return seg.fromPeriod <= period && (seg.toPeriod === null || period <= seg.toPeriod);
}

export function valueAt(segments: RuleSegment[], param: GoalParam, period: string): number | null {
  let best: RuleSegment | null = null;
  for (const s of segments) {
    if (s.param !== param || !covers(s, period)) continue;
    if (!best || s.seq > best.seq) best = s;
  }
  return best && !best.cleared ? best.value : null;
}

export interface PlannedChange {
  segment: Omit<RuleSegment, 'seq'>;
  /** 被新规则覆盖掉的、原本已排定的未来设置。 */
  replacedFuture: { fromPeriod: string; value: number }[];
  previousCurrent: number | null;
}

export function planRuleChange(
  segments: RuleSegment[],
  param: GoalParam,
  value: number,
  scope: ChangeScope,
  current: string,
  next: string,
): PlannedChange {
  const own = segments.filter((s) => s.param === param);
  const previousCurrent = valueAt(own, param, current);
  let segment: Omit<RuleSegment, 'seq'>;
  let replacedFuture: { fromPeriod: string; value: number }[] = [];
  if (scope === 'current_only') {
    segment = { param, value, fromPeriod: current, toPeriod: current };
  } else if (scope === 'current_and_future') {
    segment = { param, value, fromPeriod: current, toPeriod: null };
    replacedFuture = own.filter((s) => s.fromPeriod > current && !s.cleared).map((s) => ({ fromPeriod: s.fromPeriod, value: s.value }));
  } else {
    segment = { param, value, fromPeriod: next, toPeriod: null };
    replacedFuture = own.filter((s) => s.fromPeriod >= next && !s.cleared).map((s) => ({ fromPeriod: s.fromPeriod, value: s.value }));
  }
  replacedFuture = replacedFuture.filter((r) => r.value !== value);
  return { segment, replacedFuture, previousCurrent };
}
