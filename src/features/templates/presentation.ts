import type { TemplateDefinition } from '../../lib/contracts'

export function templatePresentation(template: TemplateDefinition) {
  if (template.engine === 'ledger') return {
    intro: '记下日常开销，清楚掌握每个月的钱花在哪里。',
    features: [
      { title: '月度预算', text: '设置每月预算，查看已用金额和剩余额度。' },
      { title: '分类账目', text: '按餐饮、交通等分类记录支出，回看每笔开销。' },
      { title: '退款关联', text: '退款关联原支出，自动计算实际花费。' },
      { title: '对话记账', text: '说一句话就能记账，也可以手动填写和修改。' },
    ],
  }
  if (template.engine === 'study') return {
    intro: '留住每一次阅读，看到一周里的积累与坚持。',
    features: [
      { title: '阅读日历', text: '按周查看阅读时长、记录天数和每天的完成情况。' },
      { title: '阅读目标', text: '设置每周读几天、每天读多久，按自己的节奏坚持。' },
      { title: '阅读笔记', text: '在记录里留下书名、阅读位置和当次收获。' },
      { title: '对话记录', text: '告诉它读了多久，也可以手动记录、修改或删除。' },
    ],
  }
  const summaries = template.metrics.filter((metric) => metric.operation !== 'goal_progress')
  const hasGoal = template.components.includes('goal') && template.metrics.some((metric) => metric.operation === 'goal_progress')
  const fields = template.recordFields.filter((field) => field.type !== 'date').map((field) => field.label).join('、')
  return {
    intro: template.description || `记录${template.name}，随时查看${[...summaries.map((metric) => metric.label), ...(hasGoal ? ['目标进度'] : [])].join('和') || '每天的积累'}。`,
    features: [
      { title: [...new Set(template.metrics.map(metric => ({ day: '每日', week: '每周', month: '每月' })[metric.period]))].join(' / ') + '统计', text: summaries.length ? `按各自周期自动汇总${summaries.map((metric) => metric.label).join('、')}，也能按日期回看。` : '按日期整理记录，随时回看每天的积累。' },
      hasGoal ? { title: '目标进度', text: '设置适合自己的目标，查看已完成的比例和剩余量。' } : { title: '记录详情', text: `每次可以记录${fields || '当日的情况'}。` },
      ...(template.components.includes('trend') ? [{ title: '变化趋势', text: '按日查看数值变化，也可展开明细核对。' }] : []),
      ...(template.components.includes('categories') ? [{ title: '分类统计', text: '按模板指定的分类比较结果和有效样本。' }] : []),
      { title: '随时修改', text: '记错了可以修改或删除，统计会随记录一起更新。' },
      { title: '对话记录', text: '直接说出记录内容，缺少的信息会继续询问，也可以手动填写。' },
    ],
  }
}
