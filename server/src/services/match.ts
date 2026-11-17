import type { PlanRow } from './repo.js';

/** 活动名到学习计划的匹配：先精确，再按“阅读类 / 英语类”关键词归类；只在唯一命中时返回。 */
const ACTIVITY_FAMILIES: RegExp[] = [/读|书|阅读/, /英语|单词|听力|口语|英文/];
export function matchStudyByActivity(plans: PlanRow[], activity: string): PlanRow | undefined {
  const studies = plans.filter((p) => p.kind === 'study');
  const exact = studies.filter((p) => p.name === activity || p.activity === activity);
  if (exact.length === 1) return exact[0];
  const fam = ACTIVITY_FAMILIES.find((re) => re.test(activity));
  if (!fam) return undefined;
  // 英语类优先判断，避免“英语阅读”被归到阅读类。
  const family = /英语|单词|听力|口语|英文/.test(activity) ? ACTIVITY_FAMILIES[1]! : fam;
  const hits = studies.filter((p) => family.test(`${p.name}${p.activity ?? ''}`) && (family === ACTIVITY_FAMILIES[1] || !ACTIVITY_FAMILIES[1]!.test(`${p.name}${p.activity ?? ''}`)));
  const active = hits.filter((p) => p.status === 'active');
  if (active.length === 1) return active[0];
  if (!active.length && hits.length === 1) return hits[0];
  return undefined;
}
