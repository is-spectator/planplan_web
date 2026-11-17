import { historyRead } from '../services/history-read.js';
import { unsupportedTemplatePlans } from '../services/template-capabilities.js';
import { registerPublicMarket, registerCommunityRoutes } from './platform.js';
import { executeForm } from '../services/form-operations.js';
import { recordEntry, linkEntry } from '../services/entry.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { attemptRequestDigest } from '../ai/usage-store.js';
import { emailAuthRoutes } from './email-auth.js';
import { verifyEmailDeletion } from '../auth/email.js';
import { Hono, type Context } from 'hono';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.js';
import type { Llm } from '../ai/llm.js';
import { DomainError } from '../services/errors.js';
import { execute, findOperation, undo, type Action } from '../services/engine.js';
import { Chat } from '../services/chat.js';
import { ledgerView, planCards, recordView, studyView } from '../services/views.js';
import { getPlan } from '../services/repo.js';
import { recordWithRefundSnapshot } from '../services/refund-snapshot.js';
import { buildExport } from '../services/export.js';
import { isBizDate, isMonthKey, monthOf, shanghaiDate, weekOf } from '../domain/time.js';
import { authenticate, issueToken, upsertUser, verifyAppleToken, verifyDevLoginSecret, type AuthConfig } from './auth.js';
import { chatBody, operationBody } from './schemas.js';
import { usage, usageLogin } from '../services/usage.js';
import { logEvent, type EventProps } from '../services/events.js';
import { legalConsentVersion, legalRoutes, type LegalConfig } from './legal.js';
import { chooseVariant, circleBoard, createCircle, growthView, joinCircle, leaveCircle, saveCaption, weeklyCard } from '../services/growth.js';
import { requestAccountDeletion, requireActiveUser } from '../services/deletion.js';
import { readinessProbe } from '../runtime/readiness.js';
import { SharedRateLimiter } from '../runtime/rate-limit.js';
import { Monitor } from '../runtime/observability.js';
import { browserSession, clearWebSession, rejectCredentialConflict, requireCookieRequest, validateWebConfig, webSessionToken, WebSessionError } from './web-session.js';
import { getAvailableTemplate, getPlanTemplate, listAvailableTemplates } from '../services/templates.js';
import { genericView } from '../services/generic.js';
import { clientCapabilities, compatibilityInfo, compatibleMessage, compatibleOperation, compatibleReply } from './response-compat.js';
import type { CreationLlm } from '../ai/creation.js';
import { CreationRequests, creationRequestBody } from '../services/creation-requests.js';
import { getCreationDraft, listCreationDrafts, getPrivateTemplate, listPrivateTemplates } from '../services/creation-drafts.js';

type Env = { Variables: { userId: string } };

const STATUS: Partial<Record<DomainError['code'] | WebSessionError['code'], number>> = {
  duplicate_confirmation_required: 409,
  refund_confirmation_required: 409,
  confirmation_expired: 409,
  operation_changed: 409,
  unauthorized: 401,
  forbidden: 403,
  credential_conflict: 401,
  account_mismatch: 409,
  csrf_invalid: 403,
  origin_forbidden: 403,
  ai_consent_required: 403,
  not_found: 404,
  version_conflict: 409,
  undo_conflict: 409,
  already_undone: 409,
  ledger_exists: 409,
  circle_conflict: 409,
  rate_limited: 429,
};

/** 客户端给出的输入时刻：允许离线后补传，但不接受未来时间。 */
function inputAtOf(s: string | undefined): Date {
  const now = Date.now();
  if (!s) return new Date(now);
  const t = Date.parse(s);
  if (Number.isNaN(t) || t > now + 5 * 60_000) return new Date(now);
  if (t < now - 30 * 86400_000) throw new DomainError('invalid_input', '这条内容保存得太久了，请重新输入。');
  return new Date(t);
}

export function createApp(db: Db, llm: Llm, auth: AuthConfig, legal?: LegalConfig, runtime: {
  releaseId?: string;
  rateLimitSecret?: Uint8Array;
  monitor?: Monitor;
  creationLlm?: CreationLlm;
  reviewerUserIds?: ReadonlySet<string>;
  /** Injected only by the isolated local fixture; production main still uses loadLegalConfig. */
  localLegal?: { routes: Hono; consentVersion: string };
} = {}) {
  validateWebConfig(auth);
  if (runtime.localLegal && (process.env.NODE_ENV === 'production' || ['beta', 'production'].includes(process.env.DEPLOYMENT_ENV ?? '') || auth.cookieSecure !== false)) {
    throw new Error('Local fixture disclosure is forbidden outside explicit loopback development');
  }
  const app = new Hono<Env>();
  const chat = new Chat(db, llm);
  const limits = new SharedRateLimiter(db, runtime.rateLimitSecret ?? auth.jwtSecret);
  const monitor = runtime.monitor ?? new Monitor();
  const ready = readinessProbe(db);

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    monitor.result('api', c.res.status < 500, Date.now() - started);
  });

  app.onError((err, c) => {
    if (err instanceof DomainError || err instanceof WebSessionError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, (STATUS[err.code] ?? 422) as 400);
    if (err instanceof SyntaxError || err instanceof ZodError) return c.json({ error: { code: 'invalid_input', message: '请求格式不正确，这次没有保存。' } }, 400);
    return c.json({ error: { code: 'internal', message: '服务出了点问题，这次没有保存，请重试。' } }, 500);
  });

  app.use('/v1/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    rejectCredentialConflict(c);
    await next();
    c.header('Cache-Control', 'private, no-store');
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    c.header('Cache-Control', 'no-store');
    const ok = await ready();
    return c.json({ ok, release: runtime.releaseId ?? 'local' }, ok ? 200 : 503);
  });
  app.route('/legal', runtime.localLegal?.routes ?? legalRoutes(legal));

  const entryBodyLimit = bodyLimit({ maxSize: 1024, onError: c => c.json({error:{code:'invalid_input',message:'请求内容过长。'}},413) });
  app.post('/v1/usage/entry', entryBodyLimit, async c => {
    let ip = 'unknown';
    if (auth.trustProxy) ip = c.req.header('X-Real-IP') ?? 'unknown';
    else { try { ip = getConnInfo(c).remote.address ?? 'unknown'; } catch {} }
    await limits.consume('write', `entry:${ip}`, 30);
    const body = z.object({entryId:z.uuid()}).strict().parse(await c.req.json());
    await recordEntry(db,body.entryId);
    return c.json({ok:true},202);
  });

  app.route('/v1/auth/email', emailAuthRoutes(db, auth));
  app.route('/v1/auth/web/email', emailAuthRoutes(db, auth, 'cookie'));
  app.get('/v1/auth/web/session', async (c) => c.json(await browserSession(c, db, auth)));

  // The official catalogue contains definitions and synthetic examples only.
  // Private adopted plans continue through authentication and account binding.
  app.get('/v1/templates', async (c) => c.json({ templates: await listAvailableTemplates(db) }));
  app.get('/v1/templates/:id', async (c) => c.json(await getAvailableTemplate(db, c.req.param('id'))));

  registerPublicMarket(app, db);

  // ───── 登录 ─────
  app.post('/v1/auth/apple', async (c) => {
    if (!auth.appleAudience) throw new DomainError('not_found', '不支持。');
    const { identityToken } = await c.req.json<{ identityToken?: string }>();
    if (!identityToken) throw new DomainError('invalid_input', '缺少 Apple 登录凭证。');
    const sub = await verifyAppleToken(auth, identityToken);
    const u = await upsertUser(db, { appleSub: sub });
    await logEvent(db, 'login', { method: 'apple' });
    await usageLogin(db, u.id, 'apple');
    return c.json({ token: await issueToken(auth, u.id, u.token_version), userId: u.id });
  });

  app.post('/v1/auth/dev', async (c) => {
    if (!auth.devLogin) throw new DomainError('not_found', '不支持。');
    verifyDevLoginSecret(auth, c.req.header('X-Dev-Login-Secret'));
    const { name } = z.object({ name: z.string().regex(/^[\w-]{2,32}$/) }).strict().parse(await c.req.json());
    const u = await upsertUser(db, { devName: name });
    await usageLogin(db, u.id, 'dev');
    return c.json({ token: await issueToken(auth, u.id, u.token_version), userId: u.id });
  });

  app.use('/v1/*', async (c, next) => {
    if (c.req.path.startsWith('/v1/auth/')) return next();
    const cookie = webSessionToken(c, auth);
    const userId = await authenticate(auth, db, cookie ? `Bearer ${cookie}` : c.req.header('authorization'));
    if (cookie) requireCookieRequest(c, auth, cookie, userId);
    c.set('userId', userId);
    return next();
  });

  const uid = (c: Context<Env>) => c.get('userId');
  const capabilities = (c: Context<Env>) => clientCapabilities(c.req.header('X-PlanPlan-Capabilities'));
  const responseCapabilities = async (c: Context<Env>) => {
    const caps = capabilities(c);
    return { ...caps, unsupportedPlanIds: await unsupportedTemplatePlans(db, uid(c), caps) };
  };
  const requirePlanCapability = async (c: Context<Env>, planId: string) => {
    if ((await unsupportedTemplatePlans(db, uid(c), capabilities(c))).has(planId)) throw new DomainError('invalid_input', '请使用新版网页查看这个计划，已保存的内容无需重复提交。');
  };
  app.post('/v1/usage/entry/link', entryBodyLimit, async c => {
    await limits.consume('write',uid(c),120);
    const body=z.object({entryId:z.uuid()}).strict().parse(await c.req.json());
    await linkEntry(db,uid(c),body.entryId);
    return c.json({ok:true});
  });
  const today = () => shanghaiDate(new Date());
  const reviewerUserIds = runtime.reviewerUserIds ?? new Set<string>();
  registerCommunityRoutes(app, db, reviewerUserIds, limits);
  const currentConsentVersion = runtime.localLegal?.consentVersion ?? (legal ? legalConsentVersion(legal) : null);
  const creation = new CreationRequests(db, runtime.creationLlm, currentConsentVersion);
  const creationPage = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict();

  app.use('/v1/creation/*', async (c, next) => {
    const caps = capabilities(c);
    if (!caps.privateTemplateCapability || !caps.genericCapability) throw new DomainError('invalid_input', '请更新网页后继续创作，已有内容仍会保留。');
    await next();
  });
  app.post('/v1/creation/requests', bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: { code: 'invalid_input', message: '模板内容过长，请简化后再试。' } }, 413) }), async c => {
    const body = creationRequestBody.parse(await c.req.json());
    await limits.consume(body.action === 'message' ? 'chat' : 'write', uid(c), body.action === 'message' ? 30 : 120);
    const result = await creation.submit(uid(c), body);
    return 'status' in result ? c.json(result, 202) : c.json(result);
  });
  app.get('/v1/creation/requests/:clientOpId', async c => c.json(await creation.lookup(uid(c), z.uuid().parse(c.req.param('clientOpId')))));
  app.get('/v1/creation/drafts', async c => c.json(await listCreationDrafts(db, uid(c), creationPage.parse(c.req.query()))));
  app.get('/v1/creation/drafts/:id', async c => c.json(await getCreationDraft(db, uid(c), z.uuid().parse(c.req.param('id')))));
  app.get('/v1/creation/templates', async c => c.json(await listPrivateTemplates(db, uid(c), creationPage.parse(c.req.query()))));
  app.get('/v1/creation/templates/:id', async c => {
    const query = z.object({ version: z.coerce.number().int().positive().optional() }).strict().parse(c.req.query());
    return c.json(await getPrivateTemplate(db, uid(c), c.req.param('id'), query.version));
  });

  app.use('/v1/chat', async (c, next) => {
    if (currentConsentVersion) {
      const [u] = await db.query<{ ai_consent: boolean; ai_consent_version: string | null }>('SELECT ai_consent, ai_consent_version FROM users WHERE id = $1', [uid(c)]);
      if (!u?.ai_consent || u.ai_consent_version !== currentConsentVersion) throw new DomainError('ai_consent_required', '云端 AI 服务说明已更新，请阅读并重新选择是否同意。');
    }
    await next();
  });

  // ───── 账户 ─────
  app.get('/v1/me', async (c) => {
    const [u] = await db.query<{ id: string; ai_consent: boolean; ai_consent_version: string | null; data_version: number; apple_sub: string | null; email: string | null }>(`SELECT id, ai_consent, ai_consent_version, data_version, apple_sub, ${auth.email ? '(SELECT email FROM email_credentials WHERE user_id = users.id)' : 'NULL'} AS email FROM users WHERE id = $1`, [uid(c)]);
    return c.json({ id: u!.id, roles: reviewerUserIds.has(uid(c)) ? ['reviewer'] : [], aiConsent: u!.ai_consent && (!currentConsentVersion || u!.ai_consent_version === currentConsentVersion), dataVersion: u!.data_version, signInMethod: u!.email ? 'email' : u!.apple_sub ? 'apple' : 'dev', timezone: 'Asia/Shanghai', today: today() });
  });

  app.put('/v1/me/ai-consent', async (c) => {
    const { granted, consentVersion } = z.object({ granted: z.boolean(), consentVersion: z.string().optional() }).strict().parse(await c.req.json());
    if (granted && currentConsentVersion && consentVersion !== currentConsentVersion) throw new DomainError('ai_consent_required', '服务说明已更新，请重新读取后再选择。');
    await db.query(`UPDATE users SET ai_consent = $2, ai_consent_at = now(), ai_consent_version = $3 WHERE id = $1`, [uid(c), granted, granted ? currentConsentVersion : null]);
    await logEvent(db, 'ai_consent', { granted: !!granted });
    return c.json({ aiConsent: !!granted });
  });

  app.post('/v1/logout', async (c) => {
    await db.query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [uid(c)]);
    if (webSessionToken(c, auth)) clearWebSession(c, auth);
    return c.json({ ok: true });
  });

  app.delete('/v1/me', async (c) => {
    const { confirm, password } = await c.req.json<{ confirm?: string; password?: string }>().catch(() => ({ confirm: undefined, password: undefined }));
    if (confirm !== 'DELETE') throw new DomainError('invalid_input', '需要二次确认才能删除账户。');
    const guard = await verifyEmailDeletion(db, auth.email, uid(c), password);
    const job = await requestAccountDeletion(db, uid(c), guard);
    if (webSessionToken(c, auth)) clearWebSession(c, auth);
    await logEvent(db, 'account_deleted', {});
    return c.json({ deleted: true, deletionJobId: job.id, cleanupStatus: job.status }, job.status === 'completed' ? 200 : 202);
  });

  // ───── 计划与详情 ─────
  app.get('/v1/plans/:id/template', async (c) => {
    const planId = z.uuid().parse(c.req.param('id'));
    const state = await getPlanTemplate(db, uid(c), planId, today());
    if (state.engine === 'generic' && !capabilities(c).genericCapability) throw new DomainError('invalid_input', '请使用新版网页查看这个计划，已保存的内容无需重复提交。');
    await requirePlanCapability(c, planId);
    return c.json(state);
  });

  app.get('/v1/plans', async (c) => {
    const status = c.req.query('status') === 'archived' ? 'archived' : 'active';
    const result = await planCards(db, uid(c), today(), status);
    const caps = await responseCapabilities(c);
    const visible = result.plans.filter(card => (caps.genericCapability || card.plan.kind !== 'generic') && !caps.unsupportedPlanIds?.has(card.plan.id));
    const hidden = result.plans.length - visible.length;
    const compatibility = hidden ? { compatibility: compatibilityInfo(hidden) } : {};
    if (!caps.templateCapability && !caps.ledgerTemplateCapability && !caps.genericCapability) return c.json({ ...result, plans: visible, ...compatibility });
    const bindings = await db.query<{ plan_id: string; template_id: string; template_version: number; setup_status: 'pending' | 'ready' }>(
      'SELECT plan_id,template_id,template_version,setup_status FROM plan_template_bindings WHERE user_id=$1', [uid(c)]);
    const byPlan = new Map(bindings.map(binding => [binding.plan_id, binding]));
    return c.json({ ...result, ...compatibility, plans: visible.map(card => {
      const binding = byPlan.get(card.plan.id);
      const supported = card.plan.kind === 'generic' ? caps.genericCapability : card.plan.kind === 'ledger' ? caps.ledgerTemplateCapability : caps.templateCapability;
      return binding && supported ? { ...card, plan: { ...card.plan, template: { id: binding.template_id, version: binding.template_version, setupStatus: binding.setup_status } } } : card;
    }) });
  });

  app.get('/v1/plans/:id/generic', async (c) => {
    if (!capabilities(c).genericCapability) throw new DomainError('invalid_input', '请使用新版网页查看这个计划，已保存的内容无需重复提交。');
    await requirePlanCapability(c, z.uuid().parse(c.req.param('id')));
    const query = z.object({
      expectedDataVersion: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      date: z.string().refine(isBizDate).optional(),
      from: z.string().refine(isBizDate).optional(),
      to: z.string().refine(isBizDate).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    }).strict().parse(c.req.query());
    if ((query.date && (query.from || query.to)) || (!!query.from !== !!query.to)) throw new DomainError('invalid_input', '请指定一天，或完整的起止日期。');
    return c.json(await historyRead(db, uid(c), query.expectedDataVersion, q => genericView(q, uid(c), z.uuid().parse(c.req.param('id')), today(), query)));
  });

  app.get('/v1/plans/:id/ledger', async (c) => {
    const plan = await getPlan(db, uid(c), c.req.param('id'));
    if (plan.kind !== 'ledger') throw new DomainError('kind_mismatch', '这个计划不使用记账视图，请在新版网页中查看。');
    const month = c.req.query('month') ?? monthOf(today());
    if (!isMonthKey(month)) throw new DomainError('invalid_input', '月份格式不正确。');
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
    const expected = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().parse(c.req.query('expectedDataVersion'));
    return c.json(await historyRead(db, uid(c), expected, q => ledgerView(q, uid(c), c.req.param('id'), month, 20, offset)));
  });

  app.get('/v1/plans/:id/study', async (c) => {
    const plan = await getPlan(db, uid(c), c.req.param('id'));
    if (plan.kind !== 'study') throw new DomainError('kind_mismatch', '这个计划不使用学习视图，请在新版网页中查看。');
    const w = c.req.query('week') ?? weekOf(today());
    if (!isBizDate(w)) throw new DomainError('invalid_input', '周的格式不正确。');
    const expected = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().parse(c.req.query('expectedDataVersion'));
    const paging = c.req.query('limit') !== undefined || c.req.query('offset') !== undefined ? { limit: z.coerce.number().int().min(1).max(100).parse(c.req.query('limit') ?? 20), offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(c.req.query('offset') ?? 0) } : undefined;
    return c.json(await historyRead(db, uid(c), expected, q => studyView(q, uid(c), c.req.param('id'), weekOf(w), today(), paging)));
  });

  app.get('/v1/records/:id', async (c) => {
    const { record: r, refundSnapshot } = await recordWithRefundSnapshot(db, uid(c), c.req.param('id'));
    if (r.kind === 'generic' && !capabilities(c).genericCapability) throw new DomainError('invalid_input', '请使用新版网页查看这条已保存的记录，无需重复提交。');
    await requirePlanCapability(c, r.plan_id);
    let source: { text: string; createdAt: string } | null = null;
    if (r.source_message_id) {
      const [m] = await db.query<{ text: string; created_at: Date }>(`SELECT text, created_at FROM messages WHERE id = $1 AND user_id = $2`, [r.source_message_id, uid(c)]);
      if (m) source = { text: m.text, createdAt: new Date(m.created_at).toISOString() };
    }
    return c.json({ record: recordView(r, refundSnapshot?.totalCents ?? null), refundSnapshot, source });
  });

  // ───── 写入 ─────
  app.post('/v1/operations', async (c) => {
    await limits.consume('write', uid(c), 120);
    const body = operationBody.parse(await c.req.json());
    const caps = capabilities(c);
    const confirmationId = c.req.header('X-PlanPlan-Confirmation');
    if (confirmationId) z.uuid().parse(confirmationId);
    const started = Date.now();
    const props = { requestHash: attemptRequestDigest(uid(c), body.clientOpId), source: 'form' as const, intent: 'write' as const, records: body.actions.filter(a => ['add_expense','add_refund','add_study','add_generic_record'].includes(a.type)).length, clarificationRounds: 0 };
    await usage(db, uid(c), 'request', `${body.clientOpId}:started`, { ...props, status: 'started', latencyMs: 0 });
    try {
      const res = await executeForm(db, { userId: uid(c), inputAt: inputAtOf(body.inputAt), source: 'form', ...caps }, body.clientOpId, body.actions as Action[], { confirmationId, inputAtProvided: body.inputAt !== undefined });
      await usage(db, uid(c), 'request', `${body.clientOpId}:succeeded`, { ...props, status: 'succeeded', clarificationRounds: res.clarificationRounds ?? 0, latencyMs: Date.now() - started });
      return c.json(compatibleOperation(res, await responseCapabilities(c)));
    } catch (error) {
      if (error instanceof DomainError && error.code === 'duplicate_confirmation_required') {
        await usage(db, uid(c), 'request', `${body.clientOpId}:clarification`, { ...props, status: 'clarification', clarificationRounds: 1, latencyMs: Date.now() - started });
        throw error;
      }
      await usage(db, uid(c), 'request', `${body.clientOpId}:rejected`, { ...props, status: 'rejected', latencyMs: Date.now() - started });
      await usage(db, uid(c), 'failure', `${body.clientOpId}:tool`, { requestHash: props.requestHash, category: 'tool', code: error instanceof DomainError ? 'domain_rejected' : 'internal', retryResult: 'unknown', latencyMs: Date.now() - started });
      throw error;
    }
  });

  /** 结果未知时先查原操作，再决定是否用同一标识重试。 */
  app.get('/v1/operations/:clientOpId', async (c) => {
    const op = await findOperation(db, uid(c), c.req.param('clientOpId'));
    return op ? c.json({ status: 'succeeded', result: compatibleOperation(op, await responseCapabilities(c)) }) : c.json({ status: 'not_found' }, 404);
  });

  app.post('/v1/operations/:id/undo', async (c) => {
    await limits.consume('write', uid(c), 120);
    const { clientOpId, recordId, inputAt } = await c.req.json<{ clientOpId?: string; recordId?: string; inputAt?: string }>();
    if (recordId !== undefined && !/^[0-9a-f-]{36}$/i.test(recordId)) throw new DomainError('invalid_input', '记录标识不正确。');
    const caps = capabilities(c);
    return c.json(compatibleOperation(await undo(db, { userId: uid(c), inputAt: inputAtOf(inputAt), source: 'form', ...caps }, c.req.param('id'), clientOpId ?? randomUUID(), recordId), await responseCapabilities(c)));
  });

  // ───── 对话 ─────
  app.get('/v1/chat/:clientMsgId', async (c) => {
    const id = z.string().min(1).max(120).parse(c.req.param('clientMsgId'));
    const reply = await chat.lookup(uid(c), id);
    c.header('Cache-Control', 'no-store');
    if (reply) return c.json({ status: 'succeeded', result: compatibleReply(reply, await responseCapabilities(c)) });
    return c.json({ status: chat.processing(uid(c), id) ? 'processing' : 'not_found' });
  });

  app.post('/v1/chat', async (c) => {
    await limits.consume('chat', uid(c), 30);
    const body = chatBody.parse(await c.req.json());
    const caps = capabilities(c);
    const reply = await chat.send(uid(c), { clientMsgId: body.clientMsgId, text: body.text, inputAt: inputAtOf(body.inputAt), scopePlanId: body.scopePlanId ?? null, pendingId: body.pendingId ?? null, choice: body.choice ?? null, ...caps });
    return c.json(compatibleReply(reply, await responseCapabilities(c)));
  });

  app.get('/v1/messages', async (c) => {
    const before = c.req.query('before');
    const scopePlanId = c.req.query('scopePlanId');
    if (scopePlanId !== undefined) z.uuid().parse(scopePlanId);
    const caps = await responseCapabilities(c);
    const page = await chat.historyPage(uid(c), 50, before && !Number.isNaN(Date.parse(before)) ? before : undefined, scopePlanId, c.req.query('cursor'));
    return c.json({ ...page, messages: page.messages.map(message => compatibleMessage(message, caps)) });
  });

  app.get('/v1/messages/:id', async c => {
    const message = await chat.message(uid(c), z.uuid().parse(c.req.param('id')));
    const caps = await responseCapabilities(c);
    if (message.scopePlanId && caps.unsupportedPlanIds?.has(message.scopePlanId)) throw new DomainError('invalid_input', '请在新版网页中查看这条消息。');
    return c.json({ message: compatibleMessage(message, caps) });
  });

  // ───── 成长小屋 ─────
  app.get('/v1/growth', async (c) => c.json(await growthView(db, uid(c), today())));

  app.put('/v1/growth/items/:slot', async (c) => {
    await limits.consume('write', uid(c), 120);
    const { variant } = z.object({ variant: z.string().max(32) }).strict().parse(await c.req.json());
    const slots = await db.tx(async q => { await requireActiveUser(q, uid(c)); return chooseVariant(q, uid(c), c.req.param('slot'), variant); }, uid(c));
    await logEvent(db, 'house_item_chosen', { slot: c.req.param('slot'), variant } as EventProps<'house_item_chosen'>);
    return c.json({ slots });
  });

  app.get('/v1/growth/weekly', async (c) => {
    const w = c.req.query('week') ?? weekOf(today());
    if (!isBizDate(w) || weekOf(w) > weekOf(today())) throw new DomainError('invalid_input', '周的格式不正确。');
    return c.json(await weeklyCard(db, uid(c), weekOf(w)));
  });

  app.put('/v1/growth/weekly/:week', async (c) => {
    await limits.consume('write', uid(c), 120);
    const w = c.req.param('week');
    if (!isBizDate(w) || weekOf(w) !== w || w > weekOf(today())) throw new DomainError('invalid_input', '周的格式不正确。');
    const { caption } = z.object({ caption: z.string() }).strict().parse(await c.req.json());
    await db.tx(async q => { await requireActiveUser(q, uid(c)); await saveCaption(q, uid(c), w, caption); }, uid(c));
    return c.json(await weeklyCard(db, uid(c), w));
  });

  app.get('/v1/growth/circle', async (c) => c.json({ board: await circleBoard(db, uid(c), today()) }));

  app.post('/v1/growth/circle', async (c) => {
    await limits.consume('write', uid(c), 120);
    const body = z.object({ name: z.string().optional(), code: z.string().optional(), nickname: z.string() }).strict().parse(await c.req.json());
    await db.tx(async (q) => {
      await requireActiveUser(q, uid(c));
      if (body.code !== undefined) await joinCircle(q, uid(c), body.code, body.nickname, today());
      else await createCircle(q, uid(c), body.name, body.nickname, today());
    }, uid(c));
    await logEvent(db, body.code !== undefined ? 'circle_joined' : 'circle_created', {});
    return c.json({ board: await circleBoard(db, uid(c), today()) });
  });

  app.delete('/v1/growth/circle', async (c) => {
    await limits.consume('write', uid(c), 120);
    await db.tx(async q => { await requireActiveUser(q, uid(c)); await leaveCircle(q, uid(c)); }, uid(c));
    await logEvent(db, 'circle_left', {});
    return c.json({ board: null });
  });

  // ───── 导出 ─────
  app.get('/v1/export', async (c) => {
    const zip = await buildExport(db, uid(c));
    await logEvent(db, 'export', {});
    return new Response(zip as unknown as BodyInit, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="planplan-export-${today()}.zip"` } });
  });

  return app;
}
