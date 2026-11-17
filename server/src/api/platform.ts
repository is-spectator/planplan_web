import { FeedbackRequests, feedbackRequestBody, listOwnFeedback, listFeedbackQueue, getFeedbackTicket } from '../services/feedback.js';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { SharedRateLimiter } from '../runtime/rate-limit.js';
import { DomainError } from '../services/errors.js';
import { getAvailableTemplate, listAvailableTemplates } from '../services/templates.js';
import { CommunityRequests } from '../services/community-requests.js';
import { communityCategorySchema, communityRequestBody, getAuthorCommunityListing, getReviewCommunityListing, getCommunityHistory, getCommunitySubmission, getCommunityTemplate, getCommunityUpgrade, getPublicationEligibility, listAuthorCommunity, listCommunityReports, listCommunityReviewQueue, listCommunityTemplates } from '../services/community.js';
import type { TemplateDefinition } from '../templates/contracts.js';
import { clientCapabilities } from './response-compat.js';

type App = Hono<{ Variables: { userId: string } }>;
const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0) });
const version = z.coerce.number().int().positive();
function officialCard(definition: TemplateDefinition) {
  return { id: definition.id, templateId: definition.id, source: 'official' as const, title: definition.name, description: definition.description,
    category: definition.engine === 'ledger' ? 'finance' : definition.engine === 'study' ? 'reading' : 'health',
    author: { kind: 'official', name: 'PlanPlan' }, templateVersion: definition.version, adoptionCount: null, definition };
}
export function registerPublicMarket(app: App, db: Db) {
  app.get('/v1/market/templates', async c => {
    const query = page.extend({ q: z.string().trim().max(80).default(''), source: z.enum(['all','official','community']).default('all'), category: communityCategorySchema.optional() }).strict().parse(c.req.query());
    const official = query.source === 'community' ? [] : (await listAvailableTemplates(db)).map(officialCard).filter(t => (!query.category || query.category === t.category) && `${t.title} ${t.description}`.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()));
    const visible = official.slice(query.offset, query.offset + query.limit);
    const community = query.source === 'official' ? { templates: [], total: 0 } : await listCommunityTemplates(db, { q: query.q, category: query.category, limit: Math.max(1, query.limit - visible.length), offset: Math.max(0, query.offset - official.length) });
    return c.json({ templates: [...visible, ...community.templates.slice(0, query.limit - visible.length)], total: official.length + community.total, limit: query.limit, offset: query.offset });
  });
  app.get('/v1/market/templates/:id', async c => {
    const query = z.object({ version: version.optional() }).strict().parse(c.req.query());
    if (c.req.param('id').startsWith('community.')) return c.json(await getCommunityTemplate(db, c.req.param('id'), query.version));
    const definition = await getAvailableTemplate(db, c.req.param('id'));
    if (query.version && query.version !== definition.version) throw new DomainError('version_conflict', '模板已更新，请重新打开后核对。');
    return c.json(officialCard(definition));
  });
}
export function registerCommunityRoutes(app: App, db: Db, reviewerUserIds: ReadonlySet<string>, limits: SharedRateLimiter) {
  const feedback = new FeedbackRequests(db, { reviewerUserIds });
  const requests = new CommunityRequests(db, { reviewerUserIds });
  app.use('/v1/community/*', async (c,next) => {
    const caps = clientCapabilities(c.req.header('X-PlanPlan-Capabilities'));
    if (!caps.communityTemplateCapability || !caps.genericCapability) throw new DomainError('invalid_input','请更新网页后继续使用社区模板。');
    await next();
  });
  app.post('/v1/community/requests', bodyLimit({ maxSize: 64 * 1024 }), async c => {
    await limits.consume('write',c.get('userId'),120);
    return c.json(await requests.submit(c.get('userId'),communityRequestBody.parse(await c.req.json())));
  });
  app.get('/v1/community/requests/:id', async c => c.json(await requests.lookup(c.get('userId'),z.uuid().parse(c.req.param('id')))));
  app.get('/v1/community/works', async c => c.json(await listAuthorCommunity(db,c.get('userId'),page.strict().parse(c.req.query()))));
  app.get('/v1/community/works/:id', async c => c.json(await getAuthorCommunityListing(db,c.get('userId'),z.uuid().parse(c.req.param('id')))));
  app.get('/v1/community/works/:id/history', async c => c.json(await getCommunityHistory(db,c.get('userId'),z.uuid().parse(c.req.param('id')),new Set(),page.strict().parse(c.req.query()))));
  app.get('/v1/community/submissions/:id', async c => c.json(await getCommunitySubmission(db,c.get('userId'),z.uuid().parse(c.req.param('id')),reviewerUserIds)));
  app.get('/v1/community/review', async c => c.json(await listCommunityReviewQueue(db,c.get('userId'),reviewerUserIds,page.extend({status:z.enum(['pending','approved','rejected','withdrawn','published']).optional()}).strict().parse(c.req.query()))));
  app.get('/v1/community/review/works/:id', async c => c.json(await getReviewCommunityListing(db,c.get('userId'),z.uuid().parse(c.req.param('id')),reviewerUserIds)));
  app.get('/v1/community/review/works/:id/history', async c => {
    await getReviewCommunityListing(db,c.get('userId'),z.uuid().parse(c.req.param('id')),reviewerUserIds);
    return c.json(await getCommunityHistory(db,c.get('userId'),z.uuid().parse(c.req.param('id')),reviewerUserIds,page.strict().parse(c.req.query())));
  });
  app.get('/v1/community/reports', async c => c.json(await listCommunityReports(db,c.get('userId'),reviewerUserIds,page.extend({status:z.enum(['open','dismissed','actioned']).optional()}).strict().parse(c.req.query()))));
  app.get('/v1/creation/templates/:id/publication-eligibility', async c => {
    const query=z.object({version:version.optional()}).strict().parse(c.req.query());
    return c.json(await getPublicationEligibility(db,c.get('userId'),c.req.param('id'),query.version));
  });
  app.post('/v1/feedback/requests', bodyLimit({maxSize:12*1024}), async c => {
    await limits.consume('write',c.get('userId'),30);
    return c.json(await feedback.submit(c.get('userId'),feedbackRequestBody.parse(await c.req.json())));
  });
  app.get('/v1/feedback/requests/:id', async c => c.json(await feedback.lookup(c.get('userId'),z.uuid().parse(c.req.param('id')))));
  app.get('/v1/feedback', async c => c.json(await listOwnFeedback(db,c.get('userId'),page.strict().parse(c.req.query()))));
  app.get('/v1/feedback/review', async c => c.json(await listFeedbackQueue(db,c.get('userId'),reviewerUserIds,page.extend({status:z.enum(['open','in_progress','resolved']).optional()}).strict().parse(c.req.query()))));
  app.get('/v1/feedback/:id', async c => c.json(await getFeedbackTicket(db,c.get('userId'),z.uuid().parse(c.req.param('id')),reviewerUserIds)));
  app.get('/v1/plans/:id/community-upgrade', async c => {
    const caps=clientCapabilities(c.req.header('X-PlanPlan-Capabilities'));
    if(!caps.communityTemplateCapability || !caps.genericCapability || !caps.genericTemplateV2Capability) throw new DomainError('invalid_input','请更新网页后查看模板更新。');
    const query=z.object({targetVersion:version}).strict().parse(c.req.query());
    return c.json({...await getCommunityUpgrade(db,c.get('userId'),z.uuid().parse(c.req.param('id')),query.targetVersion),compatible:true});
  });
}
