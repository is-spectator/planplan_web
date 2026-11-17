import { formatYuan } from '../domain/money.js';
import { formatMonthDay, monthOf, nextMonth } from '../domain/time.js';
import type { ItemResult } from './engine.js';
import type { QueryCard } from './query.js';
import type { TemplateDefinition } from '../templates/contracts.js';
import type { RecordView } from './views.js';

const monthCN = (m: string) => `${Number(m.slice(5, 7))} 月`;
const weekCN = (w: string) => `${formatMonthDay(w)}这一周`;

function genericValueText(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return '暂无';
  if (Array.isArray(value)) return value.join('、') || '无';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number' && unit === 'CNY_cent') return `${Number.isInteger(value) ? '' : '约'}${formatYuan(Math.round(value))}`;
  return `${String(value)}${unit === 'minute' ? ' 分钟' : unit === 'ml' ? ' 毫升' : ''}`;
}

export function recordText(r: RecordView, planName?: string, definition?: TemplateDefinition): string {
  const where = planName ? ` · ${planName}` : '';
  if (r.kind === 'generic') {
    const fields = definition?.recordFields.filter(field => field.id !== 'date' && r.fields?.[field.id] != null).map(field => `${field.label} ${genericValueText(r.fields![field.id], field.unit)}`) ?? [];
    return `${fields.join(' · ') || '通用记录'} · ${formatMonthDay(r.date)}${where}`;
  }
  if (r.kind === 'study') return `${planName ?? '学习'} ${r.minutes} 分钟 · ${formatMonthDay(r.date)}`;
  if (r.kind === 'refund') return `退款 ${formatYuan(r.amountCents!)}${r.note ? ` · ${r.note}` : ''} · ${formatMonthDay(r.date)}${where}`;
  return `${r.note || '支出'} ${formatYuan(r.amountCents!)} · ${r.category} · ${formatMonthDay(r.date)}${where}`;
}

const paramText = (param: string, v: number) => (param === 'budget_cents' ? `月预算 ${formatYuan(v)}` : param === 'days_per_week' ? `每周 ${v} 天` : `每天至少 ${v} 分钟`);

/** 回执的说明文字。所有数字来自执行结果。 */
export function itemsText(items: ItemResult[]): string {
  const parts: string[] = [];
  const records = items.filter((i) => i.type === 'expense_added' || i.type === 'refund_added' || i.type === 'study_added' || i.type === 'generic_added');
  if (records.length > 1) parts.push(`记好了，${records.length} 条都已保存。`);
  else if (records.length === 1) parts.push('记好了。');
  for (const it of items) {
    switch (it.type) {
      case 'generic_added':
        if (it.record.defaultedFields?.length) parts.push('未填写的部分已沿用你设置的常用值，可在记录详情核对或修改。');
        break;
      case 'plan_created':
        if (it.plan.kind === 'ledger') {
          parts.unshift(it.budgetCents ? `已建好「日常记账」，月预算 ${formatYuan(it.budgetCents)}，从本月起生效。` : '已建好「日常记账」，现在就可以记。预算想设的时候再告诉我。');
        } else if (it.plan.kind === 'generic') {
          parts.unshift(`已建立「${it.plan.name}」计划，设置目标后也需要单独记录实际完成的内容。`);
        } else {
          let t = `已建立「${it.plan.name}」计划`;
          if (it.daysPerWeek && it.minMinutes) t += `：每周 ${it.daysPerWeek} 天，每天累计至少 ${it.minMinutes} 分钟算达标。统计周为周一至周日。`;
          else if (it.daysPerWeek) t += `：每周 ${it.daysPerWeek} 天。每天至少多少分钟算一天达标？告诉我就能开始统计达标天数，现在也可以先记录时长。`;
          else if (it.minMinutes) t += `：每天至少 ${it.minMinutes} 分钟。每周想达标几天？现在也可以先记录时长。`;
          else t += '，现在就可以记录时长。想定目标的话，告诉我每周几天、每天多少分钟。';
          if (it.goalStartsOn) t += `目标从 ${it.goalStartsOn} 开始，本周只记录时长，不评价达标。`;
          if (!it.goalStartsOn && it.daysPerWeek && it.firstWeekTarget !== null && it.firstWeekTarget < it.daysPerWeek) t += `本周从 ${it.plan.startDate} 开始，可用 ${it.firstWeekTarget} 天，首周目标按 ${it.firstWeekTarget} 天算，下周起每周 ${it.daysPerWeek} 天。`;
          parts.unshift(t);
        }
        break;
      case 'goal_set': {
        const scopeText =
          it.scope === 'current_only'
            ? `只在${it.param === 'budget_cents' ? '本月' : '本周'}生效`
            : it.scope === 'next_and_future'
              ? `从${it.param === 'budget_cents' ? monthCN(it.effectiveFrom) : weekCN(it.effectiveFrom)}起生效，${it.param === 'budget_cents' ? '本月' : '本周'}不变`
              : `从${it.param === 'budget_cents' ? `本月（${monthCN(it.effectiveFrom)}）` : '本周'}起生效`;
        let t = `已把${paramText(it.param, it.value).replace(/^月预算/, '月预算设为').replace(/^每/, '目标改为每')}，${scopeText}。`;
        if (it.param === 'budget_cents' && it.scope !== 'next_and_future' && it.previous === null) t += '月中设置不按剩余天数折算。';
        if (it.param === 'min_minutes' && it.scope !== 'next_and_future') t += '本周已有的记录按新门槛重新计算。';
        for (const r of it.replacedFuture) t += `原定${it.param === 'budget_cents' ? monthCN(r.fromPeriod) : weekCN(r.fromPeriod)}起的${paramText(it.param, r.value)}已被替换。`;
        if (it.scope === 'current_only' && it.param === 'budget_cents') t += `${monthCN(nextMonth(monthOf(it.effectiveFrom + '-01')))}起恢复原来的设置。`;
        parts.push(t);
        break;
      }
      case 'record_edited': {
        const b = it.before;
        const a = it.record;
        const what = a.kind === 'study' ? '这条学习记录' : a.note || '这笔记录';
        const changes: string[] = [];
        if (b.amountCents !== a.amountCents) changes.push(`金额从 ${formatYuan(b.amountCents!)} 改为 ${formatYuan(a.amountCents!)}`);
        if (b.minutes !== a.minutes) changes.push(`时长从 ${b.minutes} 分钟改为 ${a.minutes} 分钟`);
        if (b.category !== a.category) changes.push(`分类从${b.category}改为${a.category}`);
        if (b.date !== a.date) changes.push(`日期从${formatMonthDay(b.date)}改为${formatMonthDay(a.date)}`);
        if (a.kind === 'generic' && JSON.stringify(b.fields) !== JSON.stringify(a.fields)) changes.push('记录数值或内容已更新，统计已重新计算');
        if (b.note !== a.note && !changes.length) changes.push('备注已更新');
        parts.push(`已修改${what}：${changes.join('，') || '内容未变'}。`);
        break;
      }
      case 'record_deleted':
        parts.push(it.records.length > 1 ? `已删除这笔支出和它的 ${it.records.length - 1} 笔退款，已不再计入统计。` : '已删除，这条记录不再计入统计。');
        break;
      case 'plan_updated':
        parts.push(
          it.change === 'renamed'
            ? `已改名为「${it.plan.name}」，目标和记录不变。`
            : it.change === 'archived'
              ? `已归档「${it.plan.name}」。历史仍可查看和导出，新的记录不会自动进入这个计划。`
              : it.change === 'restored'
                ? `已恢复「${it.plan.name}」。`
                : '页面已调整，数据和统计不变。',
        );
        break;
      case 'undone':
        parts.push('已撤销本批操作，后来独立保存的记录仍然保留。');
        break;
      default:
        break;
    }
  }
  return parts.join('');
}

/** 查询回答的文字。只用统计服务返回的数值，并写明周期与“已记录”的口径。 */
export function queryText(c: QueryCard): string {
  switch (c.kind) {
    case 'none':
      return c.message;
    case 'ledger_month': {
      const period = `${monthCN(c.month)}（${formatMonthDay(c.from)}–${formatMonthDay(c.to)}）`;
      if (c.focus === 'category' && c.category) {
        const l = c.byCategory.find((x) => x.category === c.category);
        return l ? `${period}${c.category}净支出 ${formatYuan(l.netCents)}${l.refundCents ? `（支出 ${formatYuan(l.spendCents)}，退款 ${formatYuan(l.refundCents)}）` : ''}，基于已记录数据。` : `${period}还没有${c.category}的记录。`;
      }
      if (c.focus === 'budget' || c.budgetCents !== null) {
        if (c.budgetCents === null) return `${period}还没有设置预算。已记录净支出 ${formatYuan(c.netCents)}。`;
        if (c.overCents) return `${period}已超出预算 ${formatYuan(c.overCents)}：已记录净支出 ${formatYuan(c.netCents)}，预算 ${formatYuan(c.budgetCents)}。`;
        return `${period}预算还剩 ${formatYuan(c.remainingCents!)}，已记录净支出 ${formatYuan(c.netCents)}，已用 ${c.usagePct}%。${c.netCents < 0 ? '本月退款多于支出。' : ''}`;
      }
      return `${period}已记录支出 ${formatYuan(c.spendCents)}，退款 ${formatYuan(c.refundCents)}，净支出 ${formatYuan(c.netCents)}。`;
    }
    case 'ledger_range': {
      const period = `${c.label ? `${c.label}（` : ''}${c.from === c.to ? formatMonthDay(c.from) : `${formatMonthDay(c.from)}–${formatMonthDay(c.to)}`}${c.label ? '）' : ''}`;
      if (c.keywords?.length) {
        const what = c.keywords.map((k) => `「${k}」`).join('/');
        const label = c.label.split(' · ')[0];
        const dates = c.from === c.to ? formatMonthDay(c.from) : `${formatMonthDay(c.from)}–${formatMonthDay(c.to)}`;
        const head = label ? `${label}（${dates}）` : dates;
        if (!c.count && !c.refundCents) return `${head}没有找到备注含${what}的支出记录。`;
        return `${head}${what}相关支出 ${formatYuan(c.spendCents)}，共 ${c.count} 笔${c.refundCents ? `，退款 ${formatYuan(c.refundCents)}，净支出 ${formatYuan(c.netCents)}` : ''}。`;
      }
      if (c.category) {
        const l = c.byCategory.find((x) => x.category === c.category);
        return l ? `${period}${c.category}净支出 ${formatYuan(l.netCents)}，基于已记录数据。` : `${period}还没有${c.category}的记录。`;
      }
      if (!c.spendCents && !c.refundCents) return `${period}还没有记录。`;
      return `${period}已记录支出 ${formatYuan(c.spendCents)}${c.refundCents ? `，退款 ${formatYuan(c.refundCents)}，净支出 ${formatYuan(c.netCents)}` : ''}。`;
    }
    case 'study_range':
      return `「${c.plan.name}」${c.label}（${c.from}–${c.to}）已记录 ${c.totalMinutes} 分钟，记录 ${c.recordDays} 天。记录天数不代表达标天数，本区间不评价周目标。`;
    case 'comparison': {
      const metric = { spend: '支出', refund: '退款', net: '净支出', minutes: '学习时长' }[c.metric];
      const value = (n: number) => c.unit === 'minutes' ? `${n} 分钟` : formatYuan(n);
      const range = (p: typeof c.current) => `${p.label}（${p.from}–${p.to}）${value(p.value)}`;
      const difference = c.delta === 0 ? '两段相同' : `前者比后者${c.delta > 0 ? '增加' : '减少'} ${value(Math.abs(c.delta))}`;
      const pct = c.changePct === null ? '基准值为零或负数，不计算百分比。' : `变化 ${c.changePct > 0 ? '+' : ''}${c.changePct}%。`;
      const scope = [c.category, c.keywords?.length ? `备注含${c.keywords.map((k) => `「${k}」`).join('/')}` : null].filter(Boolean).join('、');
      return `「${c.plan.name}」${scope}${metric}：${range(c.current)}；${range(c.previous)}。${difference}。${pct}基于已记录数据${c.unit === 'minutes' ? '，不评价周目标达标' : ''}。`;
    }
    case 'study_week': {
      const s = c.stats;
      const head = `「${c.plan.name}」${c.label}（${formatMonthDay(s.week)}–${formatMonthDay(s.days[6]!.date)}）`;
      if (s.interrupted) return `${head}是执行中断周，只看数值：记录 ${s.recordDays} 天，共 ${s.totalMinutes} 分钟。`;
      if (!s.goalComplete) return `${head}记录了 ${s.recordDays} 天，共 ${s.totalMinutes} 分钟。目标还没补全，暂不计算达标天数。`;
      const exceed = s.exceededDays ? `，超额 ${s.exceededDays} 天` : '';
      return `${head}已达标 ${s.metDays} / ${s.targetDays} 天${exceed}，共 ${s.totalMinutes} 分钟。${s.recordDays === 0 ? '本周还没有记录。' : ''}`;
    }
    case 'generic_period': {
      const s = c.summary;
      const metrics = s.metrics.map(metric => `${metric.label} ${genericValueText(metric.value, metric.unit)}${metric.target !== null ? `，目标 ${genericValueText(metric.target, metric.unit)}${metric.remaining !== null ? `，还差 ${genericValueText(metric.remaining, metric.unit)}` : ''}` : ''}`);
      return `「${c.plan.name}」${s.from === s.to ? s.from : `${s.from}–${s.to}`}已记录 ${s.recordCount} 条。${metrics.join('；')}。`;
    }
    case 'overview':
      return c.plans.length ? `${c.label}的当前情况：` : '还没有进行中的计划。';
  }
}
