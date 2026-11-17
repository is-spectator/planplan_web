import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable, Transaction } from '../db/db.js';
import { shanghaiDate } from '../domain/time.js';
import { templateDefinitionSchema, type TemplateDefinition, type TemplateField } from '../templates/contracts.js';
import { requireActiveUser } from './deletion.js';
import { fail } from './errors.js';
import { requireGenericDefinition,usesGenericV2Definition } from './generic.js';
import { getAdoptableTemplate, getPlanTemplate } from './templates.js';

export interface CreationMessage { id:string; role:'user'|'assistant'; text:string; createdAt:string }
export interface CreationDraft {
  id:string; version:number; name:string; definition:TemplateDefinition|null; messages:CreationMessage[];
  changeSummary:string[]; canUndo:boolean; savedTemplate:{id:string;version:number;name:string}|null;
  sourcePlanId:string|null; sourcePlanVersion:number|null; createdAt:string; updatedAt:string;
}
export interface PrivateTemplateListItem { id:string;version:number;name:string;description:string;draftId:string;updatedAt:string }
export interface CreationSource {sourceTemplateId?:string;sourceTemplateVersion?:number;sourcePlanId?:string}
export interface DeletedCreation {draftId:string;templateId:string}
type DraftRow = {id:string;user_id:string;template_id:string;version:number;definition:TemplateDefinition|null;definition_revision:number|null;next_revision:number;change_summary:string[];saved_template_version:number|null;saved_definition_hash:string|null;source_plan_id:string|null;source_plan_version:number|null;created_at:Date;updated_at:Date};
const shape=templateDefinitionSchema.shape;
export const creationDefinitionBodySchema=z.strictObject({name:shape.name,description:shape.description,configurationFields:shape.configurationFields,recordFields:shape.recordFields,metrics:shape.metrics,components:shape.components,example:shape.example,configurationDefaults:shape.configurationDefaults,recordDefaults:shape.recordDefaults});
export type CreationDefinitionBody=z.infer<typeof creationDefinitionBodySchema>;
export const creationDefinitionBody=(definition:TemplateDefinition):CreationDefinitionBody=>({name:definition.name,description:definition.description,configurationFields:definition.configurationFields,recordFields:definition.recordFields,metrics:definition.metrics,components:definition.components,example:definition.example,...(definition.configurationDefaults!==undefined?{configurationDefaults:definition.configurationDefaults}:{}),...(definition.recordDefaults!==undefined?{recordDefaults:definition.recordDefaults}:{})});
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>[k,canonical(value)])):v;
const json=(v:unknown)=>JSON.stringify(canonical(v));
const hash=(definition:TemplateDefinition)=>createHash('sha256').update(json(creationDefinitionBody(definition))).digest('hex');
const iso=(value:Date|string)=>new Date(value).toISOString();

export function normalizeCreationDefinition(body:unknown,id:string,version=1):TemplateDefinition {
  if(!id.startsWith('private.'))return fail('invalid_input','私人模板身份必须由服务器创建。');
  const parsed=creationDefinitionBodySchema.safeParse(body);
  if(!parsed.success) return fail('invalid_input','模板格式不完整或包含不支持的内容，请调整后再保存。');
  const definition=requireGenericDefinition({...parsed.data,id,version,schemaVersion:1,source:'private',engine:'generic',requiredCapabilities:['generic-record-v1','private-template-v1',...(usesGenericV2Definition(parsed.data)?['generic-template-v2']:[])]});
  const name=definition.configurationFields.find(f=>f.id==='name'),start=definition.configurationFields.find(f=>f.id==='startDate'),date=definition.recordFields.find(f=>f.id==='date');
  if(!name||name.type!=='text'||!name.required||(name.maxLength??200)>20||!start||start.type!=='date'||!start.required||!date||date.type!=='date'||!date.required) return fail('invalid_input','请保留计划名称、开始日期和记录日期；计划名称最多20字。');
  for(const metric of definition.metrics.filter(m=>m.operation==='goal_progress')) {
    const goal=definition.configurationFields.find(f=>f.id===metric.goalFieldId)!;
    if(goal.min===undefined||goal.min<1)return fail('invalid_input',`「${goal.label}」需设置为正数目标；暂时不设目标可以留空。`);
  }
  return definition;
}

function pagination(options:{limit?:number;offset?:number}={}) {
  const limit=options.limit??20,offset=options.offset??0;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>10000) fail('invalid_input','分页范围不正确。');
  return {limit,offset};
}
async function row(q:Queryable,userId:string,id:string):Promise<DraftRow> {
  const [draft]=await q.query<DraftRow>('SELECT d.* FROM creation_drafts d JOIN users u ON u.id=d.user_id WHERE d.id=$1 AND d.user_id=$2 AND u.deleted_at IS NULL',[id,userId]);
  return draft??fail('not_found','没有找到这个创作草稿。');
}
async function editable(q:Queryable,userId:string,id:string,expectedVersion:number) {
  await requireActiveUser(q,userId);
  const draft=await row(q,userId,id);
  if(!Number.isSafeInteger(expectedVersion)||draft.version!==expectedVersion) fail('version_conflict','草稿已在其他页面变化，请核对最新内容后继续。',{draft:await getCreationDraft(q,userId,id)});
  return draft;
}
export async function getCreationDraft(q:Queryable,userId:string,id:string):Promise<CreationDraft> {
  const draft=await row(q,userId,id);
  const messages=await q.query<{id:string;role:'user'|'assistant';text:string;created_at:Date}>('SELECT id,role,text,created_at FROM creation_messages WHERE draft_id=$1 AND user_id=$2 ORDER BY seq LIMIT 100',[id,userId]);
  const [saved]=draft.definition&&draft.saved_template_version&&draft.saved_definition_hash===hash(draft.definition)?await q.query<{definition:TemplateDefinition}>('SELECT definition FROM template_versions WHERE template_id=$1 AND version=$2 AND owner_user_id=$3',[draft.template_id,draft.saved_template_version,userId]):[];
  return {id:draft.id,version:draft.version,name:draft.definition?.name??'未命名模板',definition:draft.definition,messages:messages.map(m=>({id:m.id,role:m.role,text:m.text,createdAt:iso(m.created_at)})),changeSummary:draft.change_summary,canUndo:draft.definition_revision!==null,savedTemplate:saved?{id:draft.template_id,version:draft.saved_template_version!,name:saved.definition.name}:null,sourcePlanId:draft.source_plan_id,sourcePlanVersion:draft.source_plan_version,createdAt:iso(draft.created_at),updatedAt:iso(draft.updated_at)};
}
export async function listCreationDrafts(q:Queryable,userId:string,options:{limit?:number;offset?:number}={}) {
  const {limit,offset}=pagination(options);
  const [count]=await q.query<{total:number}>('SELECT COUNT(*)::int AS total FROM creation_drafts WHERE user_id=$1',[userId]);
  const ids=await q.query<{id:string}>('SELECT id FROM creation_drafts WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT $2 OFFSET $3',[userId,limit,offset]);
  return {drafts:await Promise.all(ids.map(d=>getCreationDraft(q,userId,d.id))),total:count!.total};
}
export async function getPrivateTemplate(q:Queryable,userId:string,id:string,version?:number):Promise<TemplateDefinition> {
  if(version!==undefined&&(!Number.isSafeInteger(version)||version<1)) return fail('invalid_input','模板版本不正确。');
  const [found]=await q.query<{definition:unknown}>('SELECT v.definition FROM template_versions v JOIN users u ON u.id=v.owner_user_id WHERE v.template_id=$1 AND v.owner_user_id=$2 AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM retired_private_templates r WHERE r.template_id=v.template_id) AND ($3::integer IS NULL OR v.version=$3) ORDER BY v.version DESC LIMIT 1',[id,userId,version??null]);
  if(!found) return fail('not_found','没有找到这个私人模板。');
  const definition=requireGenericDefinition(found.definition);
  if(definition.source!=='private')return fail('not_found','没有找到这个私人模板。');
  return definition;
}
export async function listPrivateTemplates(q:Queryable,userId:string,options:{limit?:number;offset?:number}={}) {
  const {limit,offset}=pagination(options);
  const [count]=await q.query<{total:number}>('SELECT COUNT(DISTINCT template_id)::int AS total FROM template_versions v WHERE owner_user_id=$1 AND NOT EXISTS(SELECT 1 FROM retired_private_templates r WHERE r.template_id=v.template_id)',[userId]);
  const rows=await q.query<{template_id:string;version:number;definition:TemplateDefinition;created_at:Date;draft_id:string}>(`SELECT latest.*,d.id AS draft_id FROM (SELECT DISTINCT ON(template_id) template_id,version,definition,created_at FROM template_versions WHERE owner_user_id=$1 ORDER BY template_id,version DESC) latest JOIN creation_drafts d ON d.template_id=latest.template_id AND d.user_id=$1 ORDER BY latest.created_at DESC,latest.template_id LIMIT $2 OFFSET $3`,[userId,limit,offset]);
  return {templates:rows.map(r=>({id:r.template_id,version:r.version,name:r.definition.name,description:r.definition.description,draftId:r.draft_id,updatedAt:iso(r.created_at)} satisfies PrivateTemplateListItem)),total:count!.total};
}

export async function createCreationDraft(q:Transaction,userId:string,source?:CreationSource):Promise<CreationDraft> {
  await requireActiveUser(q,userId);
  const [count]=await q.query<{total:number}>('SELECT COUNT(*)::int AS total FROM creation_drafts WHERE user_id=$1',[userId]);
  if(count!.total>=100) return fail('invalid_input','最多保留100份创作草稿，请先整理已有作品。');
  const id=randomUUID(),templateId=`private.${id}`;
  let definition:TemplateDefinition|null=null,sourcePlanId:string|null=null,sourcePlanVersion:number|null=null,sourceTemplateId:string|null=null,sourceTemplateVersion:number|null=null;
  if(source) {
    if(Boolean(source.sourcePlanId)===Boolean(source.sourceTemplateId)) return fail('invalid_input','请选择一个来源计划或模板。');
    let original:TemplateDefinition;
    if(source.sourcePlanId) {
      const state=await getPlanTemplate(q,userId,source.sourcePlanId,shanghaiDate(new Date()));
      original=state.definition;sourcePlanId=state.planId;sourcePlanVersion=state.config.version;
    } else {
      if(!Number.isSafeInteger(source.sourceTemplateVersion)||source.sourceTemplateVersion!<1) return fail('invalid_input','请选择明确的模板版本。');
      original=await getAdoptableTemplate(q,userId,source.sourceTemplateId!,source.sourceTemplateVersion);
      if(original.version!==source.sourceTemplateVersion) return fail('version_conflict','模板版本已变化，请重新选择。');
    }
    if(original.engine!=='generic') return fail('invalid_input','这个计划目前只支持调整设置。可在创作中另建私人模板。');
    if(original.source==='private')await getPrivateTemplate(q,userId,original.id,original.version);
    sourceTemplateId=original.id;sourceTemplateVersion=original.version;
    definition=normalizeCreationDefinition(creationDefinitionBody(original),templateId);
  }
  await q.query(`INSERT INTO creation_drafts(id,user_id,template_id,definition,definition_revision,next_revision,change_summary,source_plan_id,source_plan_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,userId,templateId,definition?JSON.stringify(definition):null,definition?1:null,definition?1:0,JSON.stringify(definition?['已复制模板结构，原计划和记录保持不变。']:[]),sourcePlanId,sourcePlanVersion]);
  if(source)await q.query('UPDATE creation_drafts SET publish_eligible=false,source_template_id=$2,source_template_version=$3 WHERE id=$1',[id,sourceTemplateId,sourceTemplateVersion]);
  if(definition)await q.query('INSERT INTO creation_revisions(draft_id,user_id,revision,parent_revision,definition) VALUES($1,$2,1,NULL,$3)',[id,userId,JSON.stringify(definition)]);
  return getCreationDraft(q,userId,id);
}

function describeChanges(before:TemplateDefinition|null,after:TemplateDefinition):string[] {
  if(!before)return [`创建「${after.name}」模板`, `包含${after.recordFields.length}个记录项目和${after.metrics.length}项统计`];
  const changes:string[]=[];
  if(before.name!==after.name)changes.push(`模板名称改为「${after.name}」`);
  if(before.description!==after.description)changes.push('更新功能简介');
  for(const [key,label] of [['configurationFields','设置项'],['recordFields','记录项']] as const) {
    for(const f of after[key]) {const old=before[key].find(x=>x.id===f.id);if(!old)changes.push(`新增${label}「${f.label}」`);else if(json(old)!==json(f))changes.push(`调整${label}「${f.label}」`);}
    for(const f of before[key])if(!after[key].some(x=>x.id===f.id))changes.push(`移除${label}「${f.label}」`);
    if(json(before[key].map(f=>f.id))!==json(after[key].map(f=>f.id))&&before[key].length===after[key].length)changes.push(`调整${label}顺序`);
  }
  if(json(before.metrics)!==json(after.metrics))changes.push('调整统计指标');
  if(json(before.configurationDefaults)!==json(after.configurationDefaults))changes.push('调整首次设置的建议值');
  if(json(before.recordDefaults)!==json(after.recordDefaults))changes.push('调整记录默认填写的建议');
  if(json(before.components)!==json(after.components))changes.push('调整页面展示');
  if(json(before.example)!==json(after.example))changes.push('更新独立示例');
  return changes.length?changes:['模板结构保持不变'];
}
async function verifyFieldIdentity(q:Queryable,draft:DraftRow,next:TemplateDefinition) {
  const history=await q.query<{definition:TemplateDefinition}>('SELECT definition FROM creation_revisions WHERE draft_id=$1 AND user_id=$2 ORDER BY revision',[draft.id,draft.user_id]);
  for(const key of ['configurationFields','recordFields'] as const)for(const field of next[key])for(const prior of history) {
    const old=prior.definition[key].find(f=>f.id===field.id);
    if(old&&(old.type!==field.type||old.unit!==field.unit)) return fail('invalid_input',`「${field.label}」改变类型或单位时需要新建记录项目，不能复用原项目。`);
    if(old&&draft.definition&&!draft.definition[key].some(f=>f.id===field.id)) return fail('invalid_input',`已移除的「${old.label}」不能用于新的项目；可撤回修改来恢复原项目。`);
  }
}
async function persistMessages(q:Queryable,draft:DraftRow,turn:{userText:string;assistantText:string}) {
  const [count]=await q.query<{n:number}>('SELECT COUNT(*)::int AS n FROM creation_messages WHERE draft_id=$1',[draft.id]);
  if(count!.n+2>100)return fail('invalid_input','这份草稿的对话已达上限，可以保存模板后开启新的创作。');
  for(const [role,text] of [['user',turn.userText],['assistant',turn.assistantText]] as const) {
    if(!text.trim()||text.length>6000)return fail('invalid_input','创作消息需为1到6000字。');
    await q.query('INSERT INTO creation_messages(draft_id,user_id,role,text) VALUES($1,$2,$3,$4)',[draft.id,draft.user_id,role,text]);
  }
}
export async function updateCreationDraft(q:Transaction,userId:string,id:string,expectedVersion:number,body:unknown,turn?:{userText:string;assistantText:string}):Promise<CreationDraft> {
  const draft=await editable(q,userId,id,expectedVersion);
  const definition=normalizeCreationDefinition(body,draft.template_id);
  await verifyFieldIdentity(q,draft,definition);
  if(turn)await persistMessages(q,draft,turn);
  const changed=json(draft.definition&&creationDefinitionBody(draft.definition))!==json(creationDefinitionBody(definition));
  const revision=changed?draft.next_revision+1:draft.definition_revision;
  if(changed)await q.query('INSERT INTO creation_revisions(draft_id,user_id,revision,parent_revision,definition) VALUES($1,$2,$3,$4,$5)',[id,userId,revision,draft.definition_revision,JSON.stringify(definition)]);
  await q.query('UPDATE creation_drafts SET definition=$2,definition_revision=$3,next_revision=$4,version=version+1,change_summary=$5,updated_at=now() WHERE id=$1',[id,JSON.stringify(definition),revision,changed?revision:draft.next_revision,JSON.stringify(describeChanges(draft.definition,definition))]);
  return getCreationDraft(q,userId,id);
}
export async function clarifyCreationDraft(q:Transaction,userId:string,id:string,expectedVersion:number,userText:string,assistantText:string):Promise<CreationDraft> {
  const draft=await editable(q,userId,id,expectedVersion);await persistMessages(q,draft,{userText,assistantText});
  await q.query('UPDATE creation_drafts SET version=version+1,change_summary=$2,updated_at=now() WHERE id=$1',[id,JSON.stringify(['已收到回复，模板结构保持不变'])]);
  return getCreationDraft(q,userId,id);
}
export async function undoCreationDraft(q:Transaction,userId:string,id:string,expectedVersion:number):Promise<CreationDraft> {
  const draft=await editable(q,userId,id,expectedVersion);
  if(draft.definition_revision===null)return fail('invalid_input','暂时没有可撤回的修改。');
  const [current]=await q.query<{parent_revision:number|null}>('SELECT parent_revision FROM creation_revisions WHERE draft_id=$1 AND revision=$2',[id,draft.definition_revision]);
  const [previous]=current!.parent_revision===null?[]:await q.query<{definition:TemplateDefinition}>('SELECT definition FROM creation_revisions WHERE draft_id=$1 AND revision=$2',[id,current!.parent_revision]);
  await q.query('UPDATE creation_drafts SET definition=$2,definition_revision=$3,version=version+1,change_summary=$4,updated_at=now() WHERE id=$1',[id,previous?JSON.stringify(previous.definition):null,current!.parent_revision,JSON.stringify(['已撤回最近一次结构修改，已保存版本和计划保持不变'])]);
  return getCreationDraft(q,userId,id);
}
/** The coordinator supplies idempotency; even a new request for identical content reuses its saved version. */
export async function saveCreationDraft(q:Transaction,userId:string,id:string,expectedVersion:number):Promise<CreationDraft> {
  const draft=await editable(q,userId,id,expectedVersion);
  if(!draft.definition)return fail('invalid_input','请先创建并预览模板，再保存。');
  const checked=normalizeCreationDefinition(creationDefinitionBody(draft.definition),draft.template_id),digest=hash(checked);
  if(draft.saved_definition_hash===digest&&draft.saved_template_version!==null)return getCreationDraft(q,userId,id);
  const [latest]=await q.query<{version:number}>('SELECT COALESCE(MAX(version),0)::int AS version FROM template_versions WHERE template_id=$1 AND owner_user_id=$2',[draft.template_id,userId]);
  const version=latest!.version+1,definition={...checked,version};
  await q.query('INSERT INTO template_versions(template_id,version,definition,owner_user_id) VALUES($1,$2,$3,$4)',[draft.template_id,version,JSON.stringify(definition),userId]);
  await q.query('UPDATE creation_drafts SET saved_template_version=$2,saved_definition_hash=$3,version=version+1,change_summary=$4,updated_at=now() WHERE id=$1',[id,version,digest,JSON.stringify(['私人模板已保存，可以选用创建计划'])]);
  return getCreationDraft(q,userId,id);
}

const fieldMeaning=(field:TemplateField)=>{const {label,...meaning}=field;return meaning;};
export function assertCompatibleTemplate(previous:TemplateDefinition,next:TemplateDefinition):void {
  if(previous.engine!=='generic'||next.engine!=='generic')return fail('invalid_input','当前只支持通用模板的兼容结构修改。');
  for(const key of ['configurationFields','recordFields'] as const) {
    for(const field of previous[key]) {const after=next[key].find(f=>f.id===field.id);if(!after||json(fieldMeaning(field))!==json(fieldMeaning(after)))return fail('invalid_input',`「${field.label}」的类型、单位、范围、必填性和选项必须保留；本次可修改名称或新增可选项目。`);}
    for(const field of next[key])if(!previous[key].some(f=>f.id===field.id)&&field.required)return fail('invalid_input',`新增的「${field.label}」必须是可选项目，旧记录不会自动补值。`);
  }
  for(const metric of previous.metrics) {const after=next.metrics.find(m=>m.id===metric.id);const {label,...meaning}=metric;const nextMeaning=after?Object.fromEntries(Object.entries(after).filter(([key])=>key!=='label')):null;if(!after||json(meaning)!==json(nextMeaning))return fail('invalid_input',`原有「${metric.label}」的统计口径必须保留。`);}
}
export async function exportCreationData(q:Queryable,userId:string) {
  const drafts=await q.query<{id:string}>('SELECT id FROM creation_drafts WHERE user_id=$1 ORDER BY created_at,id',[userId]);
  const versions=await q.query<{definition:TemplateDefinition}>('SELECT definition FROM template_versions v WHERE owner_user_id=$1 AND NOT EXISTS(SELECT 1 FROM retired_private_templates r WHERE r.template_id=v.template_id) ORDER BY template_id,version',[userId]);
  const revisions=await q.query('SELECT draft_id,revision,parent_revision,definition,created_at FROM creation_revisions WHERE user_id=$1 ORDER BY draft_id,revision',[userId]);
  return {drafts:await Promise.all(drafts.map(d=>getCreationDraft(q,userId,d.id))),templates:versions.map(v=>v.definition),revisions};
}

/** Keep only frozen definitions referenced by plans; delete editable content and receipts. */
export async function deleteCreationDraft(q:Transaction,userId:string,id:string,expectedVersion:number,currentRequestId?:string):Promise<DeletedCreation> {
  const draft=await editable(q,userId,id,expectedVersion);
  await q.query('INSERT INTO retired_private_templates(template_id,user_id,draft_id) VALUES($1,$2,$3)',[draft.template_id,userId,id]);
  // Hash-only tombstones prevent an old create/fork id from recreating deleted work.
  // The request currently committing the deletion keeps only its minimal result.
  await q.query(`INSERT INTO creation_deleted_requests(user_id,client_op_id,request_hash,draft_id)
    SELECT user_id,client_op_id,request_hash,$2::uuid FROM creation_requests WHERE user_id=$1
    AND ($3::uuid IS NULL OR client_op_id<>$3) AND (request->>'draftId'=$2::uuid::text OR response#>>'{draft,id}'=$2::uuid::text)
    ON CONFLICT(user_id,client_op_id) DO NOTHING`,[userId,id,currentRequestId??null]);
  await q.query('DELETE FROM creation_requests r USING creation_deleted_requests d WHERE r.user_id=$1 AND d.user_id=r.user_id AND d.client_op_id=r.client_op_id AND d.draft_id=$2',[userId,id]);
  await q.query('DELETE FROM creation_drafts WHERE id=$1 AND user_id=$2',[id,userId]);
  await q.query(`DELETE FROM template_versions v WHERE v.template_id=$1 AND v.owner_user_id=$2
    AND NOT EXISTS(SELECT 1 FROM plan_template_bindings b WHERE b.template_id=v.template_id AND b.template_version=v.version)
    AND NOT EXISTS(SELECT 1 FROM records r WHERE r.template_id=v.template_id AND r.definition_version=v.version)`,[draft.template_id,userId]);
  return {draftId:id,templateId:draft.template_id};
}
