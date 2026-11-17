import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { aiProviderConfig } from '../src/ai/provider.js';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Local developer disclosure, deliberately not a LegalConfig and never reviewed:true. */
export function webFixtureLegal(realModel: boolean, env: NodeJS.ProcessEnv = {}) {
  const { provider, baseURL, model } = aiProviderConfig(env);
  const openrouter = provider === 'openrouter';
  const endpoint = new URL(baseURL);
  const allowed = openrouter ? ['openrouter.ai'] : ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'];
  if (realModel && (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !allowed.includes(endpoint.hostname))) {
    throw new Error('Local disclosure only covers the explicitly configured model-provider HTTPS endpoint');
  }
  const recipient = openrouter ? (model.startsWith('baidu/') ? 'OpenRouter（路由平台）及百度千帆（模型服务商）' : 'OpenRouter 及其路由的模型服务商') : '阿里云百炼（通义千问 Qwen）';
  const metadata = {
    accessMode: 'development_fixture', developmentOnly: true, reviewed: false,
    policyVersion: 'local-web-2026-11-16-v1', termsVersion: 'local-web-2026-11-16-v1', effectiveDate: '2026-11-16',
    operatorName: 'PlanPlan 本机开发测试', contactEmail: 'dev@planplan.test',
    aiRecipient: realModel ? recipient : '本机受控测试模型',
    aiService: realModel ? `${openrouter ? 'OpenRouter' : '百炼'}文本模型 API，模型 ${model}，接收地址 ${endpoint.hostname}` : '固定测试响应，不调用云端模型',
    aiPrivacyURL: openrouter ? 'https://openrouter.ai/privacy' : 'https://help.aliyun.com/zh/model-studio/privacy-notice',
    aiProcessingDisclosure: realModel
      ? `仅在你同意后，将主动发送的消息、最近对话、相关计划、近期记录和统计交给${recipient}进行云端文本理解与回复。内容可能包含金额、时长、日期、分类和备注；最终事实保存与计算由本机 PlanPlan 服务完成。${openrouter ? 'OpenRouter 会把请求转发给上游模型服务商；免费模型不代表没有数据处理或保留。' : ''}接收方对调用数据的处理与保留以该服务账户的配置、适用服务协议及供应商隐私说明为准，本测试不承诺零保留。请仅使用合成测试数据。可随时关闭 AI，已有记录与手动操作继续可用。`
      : '当前仅返回本机受控测试响应，不向云端发送对话内容，也不能验证真实 AI 能力。请仅使用合成测试数据。',
    serviceRegion: realModel
      ? '应用服务和业务数据库运行在本机；模型请求发送至上面列出的服务地址，云端处理区域以接收方及上游服务商的账户与接入点配置为准。'
      : '应用服务、模型测试响应和业务数据库均在本机。',
    modelUsageDisclosure: realModel
      ? '本机数据库记录模型调用次数、模型、用量、耗时、结果和费用估算；这些调用明细不保存消息原文、金额明细或学习备注。此隔离开发进程没有启用定期清理或外部备份任务，测试数据保留到删除账户或停止服务后清理本机测试目录。'
      : '本机保留用于检查交互的合成账户、计划、记录和对话，不生成真实模型计费明细。',
    developmentDisclosure: '这是隔离本机开发测试告知，未完成正式发布审核，不代表对外服务已经就绪。dev@planplan.test 仅为合成联系标识，不能接收邮件；开发问题请在当前协作渠道反馈。正式部署必须使用经负责人确认的真实 LEGAL_CONFIG_PATH。',
    mailDisclosure: '仅使用 planplan.test 合成邮箱，验证码在本机测试邮箱中捕获，绝不向真实邮箱投递。密码由既有邮箱账户服务做单向安全哈希。',
    retentionDisclosure: '合成账户、计划、记录和聊天历史保存在本 checkout 的 server/.data/web-fixture；可通过账户删除功能清理，也可停止该服务后清理整个测试目录。没有对外邮件服务或备份服务。浏览器会话使用 HttpOnly Cookie，外观偏好可保存在本机。',
  };
  const consentVersion = createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
  const routes = new Hono();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    await next();
  });
  routes.get('/metadata', c => c.json({ ...metadata, consentVersion }));
  for (const [path, title] of [['/privacy', '本机开发测试数据说明'], ['/terms', '本机开发测试使用说明']] as const) {
    routes.get(path, c => c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · PlanPlan</title><style>body{max-width:720px;margin:auto;padding:24px;font:16px/1.8 system-ui,sans-serif}p{overflow-wrap:anywhere}a{color:#2b4c7e}</style></head><body><main><h1>${title}</h1><p>${escape(metadata.developmentDisclosure)}</p><h2>服务与数据</h2><p>${escape(metadata.serviceRegion)}</p><p>${escape(metadata.mailDisclosure)}</p><h2>AI 授权</h2><p>${escape(metadata.aiRecipient)} · ${escape(metadata.aiService)}</p><p>${escape(metadata.aiProcessingDisclosure)}</p><p>${escape(metadata.modelUsageDisclosure)}</p><p><a href="${metadata.aiPrivacyURL}" rel="noreferrer">模型服务隐私说明</a></p><h2>保存与删除</h2><p>${escape(metadata.retentionDisclosure)}</p><p>版本 ${metadata.policyVersion} · ${metadata.effectiveDate}</p></main></body></html>`));
  }
  return { routes, consentVersion };
}
