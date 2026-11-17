import type { Card, ChatReply, MessageView } from '../services/chat.js';
import type { ItemResult, OperationResult } from '../services/engine.js';

export interface ClientCapabilities {
  templateCapability: boolean;
  ledgerTemplateCapability: boolean;
  genericCapability: boolean;
  recoveryCapability: boolean;
  privateTemplateCapability?: boolean;
  genericTemplateV2Capability?: boolean;
  communityTemplateCapability?: boolean;
  unsupportedPlanIds?: ReadonlySet<string>;
}

export function clientCapabilities(header?: string): ClientCapabilities {
  const values = new Set((header ?? '').split(',').map(value => value.trim()));
  return {
    templateCapability: values.has('reading-template-v1'),
    ledgerTemplateCapability: values.has('ledger-template-v1'),
    genericCapability: values.has('generic-record-v1'),
    recoveryCapability: values.has('chat-recovery-v1'),
    privateTemplateCapability: values.has('private-template-v1'),
    genericTemplateV2Capability: values.has('generic-template-v2'),
    communityTemplateCapability: values.has('community-template-v1'),
  };
}

const compatibilityText = '部分内容需要在新版网页中查看。已保存的记录无需重复提交。';
export const compatibilityInfo = (count: number) => ({ unsupportedCount: count, message: compatibilityText, webPath: '/plans' });
const notice = (): Card => ({ type: 'notice', tone: 'info', text: compatibilityText });
const legacyItemTypes = new Set(['plan_created', 'expense_added', 'refund_added', 'study_added', 'record_edited', 'record_deleted', 'goal_set', 'plan_updated', 'undone']);

// Project copies at the HTTP boundary. Stored receipts and their recovery IDs are
// never rewritten, and successful mixed operations remain successful to old clients.
function unsupported(value: unknown, caps: ClientCapabilities): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => unsupported(item, caps));
  const object = value as Record<string, unknown>;
  if (!caps.genericCapability && (object.kind === 'generic' || object.engine === 'generic' || object.kind === 'generic_period')) return true;
  if (!caps.privateTemplateCapability && (object.source === 'private' || ['templateId', 'definitionTemplateId', 'id'].some(key => typeof object[key] === 'string' && (object[key] as string).startsWith('private.')))) return true;
  if (!caps.communityTemplateCapability && (object.source === 'community' || ['templateId','definitionTemplateId','id'].some(key => typeof object[key] === 'string' && (object[key] as string).startsWith('community.')))) return true;
  if (!caps.genericTemplateV2Capability && Array.isArray(object.requiredCapabilities) && object.requiredCapabilities.includes('generic-template-v2')) return true;
  if (caps.unsupportedPlanIds && ['id', 'planId', 'scopePlanId'].some(key => typeof object[key] === 'string' && caps.unsupportedPlanIds!.has(object[key] as string))) return true;
  return Object.entries(object).some(([key, child]) => (caps.genericCapability || key !== 'generic') && unsupported(child, caps));
}

function projectItems(items: ItemResult[], caps: ClientCapabilities): { items: ItemResult[]; hidden: number } {
  let hidden = 0;
  const result: ItemResult[] = [];
  for (const item of items) {
    if (!caps.genericCapability && !legacyItemTypes.has(item.type)) { hidden++; continue; }
    if (item.type === 'undone' || item.type === 'record_deleted') {
      const records = item.records.filter(record => !unsupported(record, caps));
      const plans = item.type === 'undone' ? item.plans.filter(plan => !unsupported(plan, caps)) : undefined;
      const omitted = records.length !== item.records.length || (item.type === 'undone' && plans!.length !== item.plans.length);
      if (!omitted) { result.push(item); continue; }
      hidden++;
      if (!records.length && (item.type !== 'undone' || !plans!.length) && unsupported(item, caps)) continue;
      const { generic: _generic, ...legacy } = item as ItemResult & { generic?: unknown };
      result.push({ ...legacy, records, ...(plans ? { plans } : {}) } as ItemResult);
    } else if (unsupported(item, caps)) {
      hidden++;
    } else {
      result.push(item);
    }
  }
  return { items: result, hidden };
}

export function compatibleOperation(result: OperationResult, caps: ClientCapabilities): OperationResult & { compatibility?: ReturnType<typeof compatibilityInfo> } {
  if (caps.genericCapability && caps.privateTemplateCapability && caps.genericTemplateV2Capability && caps.communityTemplateCapability) return result;
  const projected = projectItems(result.items, caps);
  const unsupportedTemplate = unsupported(result.templatePlan, caps);
  if (!projected.hidden && !unsupportedTemplate) return result;
  const { templatePlan, ...rest } = result;
  return { ...rest, ...(!unsupportedTemplate && templatePlan ? { templatePlan } : {}), items: projected.items, undoable: false,
    compatibility: compatibilityInfo(Math.max(projected.hidden, 1)) };
}

export function compatibleMessage(message: MessageView, caps: ClientCapabilities): MessageView {
  if (caps.genericCapability && caps.privateTemplateCapability && caps.genericTemplateV2Capability && caps.communityTemplateCapability) return message;
  const cards: Card[] = [];
  for (const card of message.cards) {
    if (card.type === 'receipt') {
      const result = projectItems(card.items, caps);
      if (result.items.length) cards.push({ ...card, items: result.items, undoable: result.hidden ? false : card.undoable });
      if (result.hidden) cards.push(notice());
    } else if (card.type === 'query' && card.kind === 'overview') {
      const plans = card.plans.filter(plan => !unsupported(plan, caps));
      if (plans.length) cards.push({ ...card, plans });
      if (plans.length !== card.plans.length) cards.push(notice());
    } else {
      cards.push(unsupported(card, caps) ? notice() : card);
    }
  }
  return { ...message, cards };
}

export function compatibleReply(reply: ChatReply, caps: ClientCapabilities): ChatReply {
  if (caps.genericCapability && caps.privateTemplateCapability && caps.genericTemplateV2Capability && caps.communityTemplateCapability) return reply;
  return { ...reply, user: compatibleMessage(reply.user, caps), assistant: compatibleMessage(reply.assistant, caps) };
}
