import type { Queryable } from '../db/db.js';
import type { TemplateDefinition } from '../templates/contracts.js';
import { fail } from './errors.js';

export interface TemplateCapabilities {
  genericCapability?: boolean;
  privateTemplateCapability?: boolean;
  genericTemplateV2Capability?: boolean;
  communityTemplateCapability?: boolean;
}
export function supportsTemplate(definition: Pick<TemplateDefinition,'engine'|'source'|'requiredCapabilities'>, caps: TemplateCapabilities, recordDefaults: Record<string,unknown> = {}) {
  return (definition.engine !== 'generic' || caps.genericCapability === true)
    && (definition.source !== 'private' || caps.privateTemplateCapability === true)
    && (definition.source !== 'community' || caps.communityTemplateCapability === true)
    && ((!definition.requiredCapabilities.includes('generic-template-v2') && !Object.keys(recordDefaults).length) || caps.genericTemplateV2Capability === true);
}
export function requireTemplateCapabilities(definition: Pick<TemplateDefinition,'engine'|'source'|'requiredCapabilities'>, caps: TemplateCapabilities, recordDefaults: Record<string,unknown> = {}) {
  if (!supportsTemplate(definition,caps,recordDefaults)) fail('invalid_input','请使用支持这个模板的新版网页操作，本次没有保存。');
}
export async function unsupportedTemplatePlans(q: Queryable, userId: string, caps: TemplateCapabilities): Promise<Set<string>> {
  const rows = await q.query<{plan_id:string;definition_snapshot:TemplateDefinition;record_defaults:Record<string,unknown>}>(
    'SELECT plan_id,definition_snapshot,record_defaults FROM plan_template_bindings WHERE user_id=$1',[userId]);
  return new Set(rows.filter(row => !supportsTemplate(row.definition_snapshot,caps,row.record_defaults)).map(row => row.plan_id));
}
