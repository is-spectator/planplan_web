import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';

const text = z.string().trim().min(1).max(4000).refine((s) => !/待填写|待确认|YOUR_|\$\(|<[^>]*>/.test(s), '不能使用占位内容');
const httpsURL = z.string().url().refine((s) => {
  const u = new URL(s);
  return u.protocol === 'https:' && !u.username && !u.password && !u.hostname.endsWith('.example') && u.hostname !== 'localhost';
}, '必须使用真实 HTTPS 地址');

/** 这是经业务负责人核对的公开告知，不是环境中秘密或任意 HTML。 */
export const legalConfigSchema = z.object({
  reviewed: z.literal(true),
  /** Omitted preserves the existing email/TestFlight beta disclosure. */
  accessMode: z.enum(['protected_test', 'email_beta', 'web_beta']).optional(),
  policyVersion: text,
  termsVersion: text,
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  operatorName: text,
  contactEmail: z.string().email().refine((s) => !s.endsWith('.example')),
  serviceRegion: text,
  aiRecipient: text,
  aiService: text,
  aiPrivacyURL: httpsURL,
  aiProcessingDisclosure: text,
  mailRecipient: text,
  mailService: text,
  retentionDisclosure: text,
}).strict();
export type LegalConfig = z.infer<typeof legalConfigSchema>;
export const LOCAL_INPUT_DISCLOSURE = '可选的普通话语音输入只在支持本机识别的设备上运行。先显示用途说明，再请求麦克风和系统语音识别权限；音频只在内存中处理，PlanPlan 不保存或上传录音，不支持本机识别时不会改用云端识别。转写文字先放入输入框供你修改，只有主动发送后才按普通对话流程处理。个人中心的昵称与头像颜色按账户保存在本机，退出或删除账户时清除，不自动同步到服务器。';
export const WEB_TEMPLATE_DISCLOSURE = '私人模板草稿、创作对话、修订和私人版本仅供所属账户访问。提交社区审核前，你会核对独立的公开简介、作者署名、模板定义及合成示例；私人记录和创作对话不会随提交公开。审核通过后仍需作者确认上架，市场上的公开资料可被任何访问者查看。其他用户采用后生成其独立计划，作者不能查看采用者的私人数据。下架会停止新的采用；删除私人草稿或作者账户不会删除其他用户已采用的计划和记录，其必要的模板快照会继续保留，作者删除账户后来源匿名显示。反馈仅在你主动提交时保存所填说明及选择附带的最小诊断信息，供服务方回复和跟进。';
export const WEB_LOCAL_DISCLOSURE = '网页在本浏览器保存登录会话和与账户绑定的待核对请求，用于刷新后确认是否已保存；确认结果后清除待核对内容。退出登录会清除本账户缓存和凭证，存在未完成请求时先提示处理。不同设备不会自动同步尚未发送的输入。网页不采集录音或精确位置。';
export const GROWTH_DISCLOSURE = '成长小屋会保存行动力、解锁物品及对应记录回忆；周卡保存你选择或编辑的文字。主动创建或加入同行榜时，圈子名称、所填昵称和成员关系会发送至服务器；同圈成员可看到昵称及本周记录天数，不会通过同行榜看到金额、备注或小屋回忆。离开或删除账户会移除成员关系，最后一位成员离开或删除后清除空圈。生活拍立得仅在你主动使用系统分享时交给所选接收方；分享前请核对画面和文字。';
export const PRODUCT_USAGE_DISCLOSURE = '产品统计使用本次安装随机生成的首次进入标识及随机化账户标识；首次进入标识在登录前用于统计注册前流失，登录后与账户关联，随账户删除。本机标识不使用硬件标识或广告标识，不跨应用跟踪。记录操作类型、结果、耗时、追问轮数、修改字段类别与用户主动选择的纠错原因；统计事件不记录消息原文、金额明细、学习备注、邮箱或IP。事件与首次进入明细在线保留最多30天，备份最多再保留28天；账户只保留首次进入时间以避免重复计算新用户，删除账户时清除；匿名汇总报告不含个人标识。';
export const MODEL_USAGE_DISCLOSURE = '我们会关联账户记录模型调用次数、模型、用量、耗时、结果和费用估算，用于费用核对、防滥用及质量诊断；不在这些调用明细中保存消息原文、收支金额或学习备注。在线个人调用明细默认保留30天，可配置更短期限，并定期清理；删除账户时清除在线明细。备份副本按隐私政策所述的备份期限清理。无法关联账户的月度费用汇总与最小计费凭据单独保留。';

/** 即使误忘递增人工版本，接收方或处理说明变化也不能沿用旧授权。 */
export function legalConsentVersion(config: LegalConfig): string {
  return createHash('sha256').update(JSON.stringify([
    config.policyVersion, config.aiRecipient, config.aiService,
    config.aiPrivacyURL, config.aiProcessingDisclosure, config.serviceRegion,
    MODEL_USAGE_DISCLOSURE, PRODUCT_USAGE_DISCLOSURE,
    ...(config.accessMode === 'web_beta' ? [WEB_LOCAL_DISCLOSURE, WEB_TEMPLATE_DISCLOSURE] : [LOCAL_INPUT_DISCLOSURE, GROWTH_DISCLOSURE]),
  ])).digest('hex');
}

export function loadLegalConfig(env: NodeJS.ProcessEnv): LegalConfig | undefined {
  const required = ['beta', 'production'].includes(env.DEPLOYMENT_ENV ?? '');
  if (!env.LEGAL_CONFIG_PATH) {
    if (required) throw new Error('Beta/正式环境必须设置并审核 LEGAL_CONFIG_PATH');
    return undefined;
  }
  // 只报告字段，不输出可能包含联系信息或合同片段的原始文件。
  let value: unknown;
  try { value = JSON.parse(readFileSync(env.LEGAL_CONFIG_PATH, 'utf8')); }
  catch { throw new Error('无法读取法律告知配置 JSON'); }
  const result = legalConfigSchema.safeParse(value);
  if (!result.success) throw new Error(`法律告知配置未完成：${result.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return result.data;
}

function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function document(title: string, version: string, cfg: LegalConfig, sections: [string, string][]): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(title)} · PlanPlan</title><style>body{font:17px/1.8 system-ui,sans-serif;max-width:720px;margin:auto;padding:24px;color:#1d1b18;background:#f6f3ee}h1{font-size:1.8em}h2{font-size:1.2em;margin-top:2em}a{color:#2b4c7e}p{white-space:pre-line;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{color:#f4f0e8;background:#141311}a{color:#8fb4f0}}</style></head><body><main><h1>${escapeHTML(title)}</h1><p>版本：${escapeHTML(version)}\n生效日期：${escapeHTML(cfg.effectiveDate)}</p>${sections.map(([heading, body]) => `<section><h2>${escapeHTML(heading)}</h2><p>${escapeHTML(body)}</p></section>`).join('')}<p>AI 服务接收方的隐私说明：<a rel="noreferrer" href="${escapeHTML(cfg.aiPrivacyURL)}">查看供应商隐私说明</a></p><p><a href="/legal/privacy">隐私政策</a> · <a href="/legal/terms">用户协议</a></p></main></body></html>`;
}

export function legalRoutes(config?: LegalConfig): Hono {
  const app = new Hono();
  const accessMode = config?.accessMode ?? 'email_beta';
  const protectedTest = accessMode === 'protected_test';
  const webBeta = accessMode === 'web_beta';
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (!config) return c.text('服务资料尚未开放，请稍后重试。', 503);
    await next();
  });
  app.get('/metadata', (c) => c.json({
    accessMode,
    policyVersion: config!.policyVersion,
    termsVersion: config!.termsVersion,
    consentVersion: legalConsentVersion(config!),
    aiRecipient: config!.aiRecipient,
    aiService: config!.aiService,
    aiProcessingDisclosure: config!.aiProcessingDisclosure,
    serviceRegion: config!.serviceRegion,
    modelUsageDisclosure: MODEL_USAGE_DISCLOSURE,
  }));
  app.get('/privacy', (c) => {
    const v = config!;
    return c.html(document('隐私政策', v.policyVersion, v, [
      ['服务主体与联系', `PlanPlan 由 ${v.operatorName} 提供。隐私问题、访问更正或删除请求可通过 ${v.contactEmail} 联系我们。服务部署区域：${v.serviceRegion}。`],
      ['账户与业务数据', `${protectedTest ? '当前测试使用服务方提供的受保护测试账号和测试口令登录。我们处理测试账号标识及登录会话，用于验证访问权限并隔离账号数据。本测试入口不开放邮箱注册，不通过邮箱验证或找回密码。' : '我们处理邮箱地址、密码的单向安全哈希和账户标识，用于注册、验证、登录、找回密码及保护账户。不会保存可还原的明文密码。'}\n你主动输入的计划、目标、开销、退款、学习时长、备注及对话用于保存记录、计算进度、查询和导出。开销明细属于财务信息；不要输入本服务不需要的银行卡号或证件信息。`],
      ['云端 AI 与单独授权', `只有你明确同意云端 AI 说明后，才会把你发送的消息、最近对话以及相关计划、近期记录和统计信息发送至 ${v.aiRecipient}（${v.aiService}）。记录可能包含金额、时长、日期、分类和备注；用途是理解表达与生成回复，保存和计算由 PlanPlan 完成。\n${v.aiProcessingDisclosure}\n你可以在设置中撤回 AI 授权；撤回后不再发送新的个人内容给模型，已有计划的查看、表单记录、编辑和导出继续可用。没有计划且未授权时可查看静态示例。`],
      [protectedTest ? '邮件服务' : '验证邮件', protectedTest ? '当前测试入口不发送邮箱验证、密码重置或营销邮件，未启用邮件服务接收方。' : `邮箱地址与验证码邮件内容会发送至 ${v.mailRecipient}（${v.mailService}），仅用于账户验证和密码重置。我们不发送营销邮件。`],
      ...(webBeta ? [['本浏览器与会话', WEB_LOCAL_DISCLOSURE], ['创作、社区模板与反馈', WEB_TEMPLATE_DISCLOSURE]] as [string, string][] : [['可选语音与本机个人资料', LOCAL_INPUT_DISCLOSURE], ['成长小屋、同行榜与主动分享', GROWTH_DISCLOSURE]] as [string, string][]),
      ['运行与产品分析', `${MODEL_USAGE_DISCLOSURE}\n${protectedTest ? PRODUCT_USAGE_DISCLOSURE.replace('注册前流失', '登录前流失') : PRODUCT_USAGE_DISCLOSURE}不会用这些数据跨应用跟踪或投放广告。`],
      ['保存、删除与恢复', v.retentionDisclosure],
      ['你的选择', '可在应用设置中导出有效计划、目标规则和记录；可撤回 AI 授权；可发起账户删除。删除入口会说明影响范围并再次确认。退出登录会清除设备上的账户缓存和凭证，未发送内容按应用提示处理。'],
      ['更新与联系', `服务接收方、数据类别或用途有实质变化时，我们会更新告知并在需要时重新取得授权。你可通过 ${v.contactEmail} 联系服务方。`],
    ]));
  });
  app.get('/terms', (c) => {
    const v = config!;
    return c.html(document('用户协议', v.termsVersion, v, [
      ['服务与内测范围', `${v.operatorName} 提供 PlanPlan，用于个人计划、记录、查询和模板创作。${webBeta ? '当前版本为邀请制网页内测，通过浏览器访问' : protectedTest ? '当前为受保护的内部测试，通过开发测试安装方式访问，尚未通过 TestFlight 分发' : '当前版本为邀请制 TestFlight 测试'}；功能可能调整，请使用应用导出功能保留需要的记录。`],
      [protectedTest ? '测试访问与账户' : '注册与账户', protectedTest ? '使用服务方提供的受保护测试账号和测试口令访问，不开放邮箱注册或邮件发送。请妥善保管测试访问凭证，仅供获准参与测试的本人使用；需要调整测试访问权限时请联系服务方。账户删除应由账户本人操作。' : '使用邮箱和密码注册，并完成邮箱验证。请使用你有权使用的邮箱，妥善保管密码。重置密码和删除账户应由账户本人操作。测试邀请与账户均供本人使用。'],
      ['AI 处理与结果核对', 'AI 能力需要单独授权。模型可能误解表达，请核对保存回执中的对象、金额或时长、日期和归属，必要时修改或撤销。统计基于你已保存的记录，不代表完整的财务情况；本服务不提供投资、医疗或其他专业决策服务。'],
      ['数据与退出', '你可以查看、编辑、导出自己的有效数据，并在设置中删除账户。账户删除范围与保存期限见隐私政策。撤回 AI 授权不影响已有计划的表单记录和导出。'],
      ...(webBeta ? [['模板发布与采用', '只发布你有权分享的模板及合成示例，发布前请核对公开预览，不要填写他人的个人信息。社区模板须经过审核并由作者确认上架；服务方可根据举报暂停展示。采用模板会建立独立计划；兼容更新须由采用者明确确认，不会自动覆盖已有记录。私人草稿删除、社区下架和账户删除是不同操作，具体影响会在操作前说明。']] as [string, string][] : []),
      ['合理使用', '不得利用本服务侵害他人权益、尝试访问其他账户、破坏服务或发送自动化滥用请求。服务可能对异常频率进行限制；限制发生时应保留输入并明确说明保存结果。'],
      ['联系与变更', `有关服务或本协议的问题请联系 ${v.contactEmail}。协议变更会标明新版本与生效日期。依法应由服务方承担的责任不因内测或模型误差说明而免除。`],
    ]));
  });
  return app;
}
