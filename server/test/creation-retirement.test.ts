import { randomUUID } from 'node:crypto';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import type { Db } from '../src/db/db.js';
import { openTestDb } from './database.js';
import { CreationRequests,creationRequestBody,type CreationDraftResult,type CreationResult,type CreationProcessing } from '../src/services/creation-requests.js';
import { creationDefinitionBody,getCreationDraft,getPrivateTemplate,listCreationDrafts,listPrivateTemplates,exportCreationData } from '../src/services/creation-drafts.js';
import { getAvailableTemplate,getPlanTemplate } from '../src/services/templates.js';
import { execute } from '../src/services/engine.js';
import { LlmError } from '../src/ai/llm.js';
import { creationDefinitionBodySchema,type CreationLlm,type CreationResult as AiResult } from '../src/ai/creation.js';
let db:Db,requests:CreationRequests;
const at=new Date('2026-11-16T04:00:00Z'),today='2026-11-16';
beforeAll(async()=>{db=await openTestDb();requests=new CreationRequests(db,undefined,null,()=>at);});
afterAll(async()=>db.close());
const request=(body:Record<string,unknown>)=>creationRequestBody.parse({clientOpId:randomUUID(),...body});
async function user(){return (await db.query<{id:string}>('INSERT INTO users(dev_name,ai_consent) VALUES($1,true) RETURNING id',[`retirement-${randomUUID()}`]))[0]!.id;}
function draft(result:CreationResult|CreationProcessing):CreationDraftResult {if('status'in result||result.kind==='delete')throw new Error('Expected draft');return result;}
async function saved(owner:string){
 const original=request({action:'create'}),created=draft(await requests.submit(owner,original));
 const body=creationDefinitionBody(await getAvailableTemplate(db,'official.water'));body.name='私人饮水';body.description='私人创作描述';
 const changed=draft(await requests.submit(owner,request({action:'update',draftId:created.draft.id,expectedVersion:created.draft.version,definition:body})));
 const result=draft(await requests.submit(owner,request({action:'save',draftId:changed.draft.id,expectedVersion:changed.draft.version})));
 return {original,result,body};
}
const deletion=(r:CreationDraftResult)=>request({action:'delete',draftId:r.draft.id,expectedVersion:r.draft.version,confirmDelete:true});
describe('私人创作删除、最小回执和在途生成隔离',()=>{
 it('删除草稿和内容回执，旧create标识不可重新创建，delete可恢复且幂等',async()=>{
  const owner=await user(),created=request({action:'create'}),r=draft(await requests.submit(owner,created));
  const clarified=draft(await requests.submit(owner,request({action:'message',draftId:r.draft.id,expectedVersion:r.draft.version,text:'取消'})));
  const del=deletion(clarified),result=await requests.submit(owner,del);
  expect(result).toEqual({clientOpId:del.clientOpId,kind:'delete',transient:false,deleted:{draftId:r.draft.id,templateId:`private.${r.draft.id}`}});
  expect(await requests.submit(owner,del)).toEqual(result);expect(await requests.lookup(owner,del.clientOpId)).toEqual({status:'succeeded',result});
  expect(await requests.lookup(owner,created.clientOpId)).toEqual({status:'not_found'});
  await expect(requests.submit(owner,created)).rejects.toMatchObject({code:'not_found'});
  expect(await db.query('SELECT id FROM creation_drafts WHERE user_id=$1',[owner])).toHaveLength(0);
  expect(await db.query('SELECT id FROM creation_messages WHERE user_id=$1',[owner])).toHaveLength(0);
  const receipts=await db.query('SELECT request,response,error FROM creation_requests WHERE user_id=$1',[owner]);
  expect(receipts).toHaveLength(1);expect(JSON.stringify(receipts)).not.toContain('已取消');
  expect(await db.query('SELECT request_hash FROM creation_deleted_requests WHERE user_id=$1',[owner])).toHaveLength(2);
 });
 it('删除无采用版本并隐藏私人列表、读取、派生、导出；阻止身份复用',async()=>{
  const owner=await user(),s=await saved(owner),id=s.result.draft.savedTemplate!.id;
  await requests.submit(owner,deletion(s.result));
  expect(await listCreationDrafts(db,owner)).toMatchObject({drafts:[],total:0});expect(await listPrivateTemplates(db,owner)).toMatchObject({templates:[],total:0});
  expect(await exportCreationData(db,owner)).toEqual({drafts:[],templates:[],revisions:[]});
  expect(await db.query('SELECT version FROM template_versions WHERE template_id=$1',[id])).toHaveLength(0);
  await expect(getPrivateTemplate(db,owner,id)).rejects.toMatchObject({code:'not_found'});
  await expect(requests.submit(owner,request({action:'fork',sourceTemplateId:id,sourceTemplateVersion:1}))).rejects.toMatchObject({code:'not_found'});
  await expect(db.query('INSERT INTO creation_drafts(id,user_id,template_id) VALUES($1,$2,$3)',[s.result.draft.id,owner,id])).rejects.toThrow();
  await expect(db.query('INSERT INTO template_versions(template_id,version,definition,owner_user_id) VALUES($1,1,$2,$3)',[id,JSON.stringify(s.result.draft.definition),owner])).rejects.toThrow();
 });
 it('保留已采用计划和记录需要的v1，移除未采用v2，继续写事实但不可派生或新采用',async()=>{
  const owner=await user(),s=await saved(owner),id=s.result.draft.savedTemplate!.id;
  const ctx={userId:owner,inputAt:at,source:'form' as const,genericCapability:true,privateTemplateCapability:true,genericTemplateV2Capability:true};
  const plan=(await execute(db,ctx,randomUUID(),[{type:'adopt_template',templateId:id,templateVersion:1}])).templatePlan!;
  await execute(db,ctx,randomUUID(),[{type:'add_generic_record',planId:plan.planId,values:{date:today,amountMl:300}}]);
  const changed=draft(await requests.submit(owner,request({action:'update',draftId:s.result.draft.id,expectedVersion:s.result.draft.version,definition:{...s.body,description:'第二版'}})));
  const second=draft(await requests.submit(owner,request({action:'save',draftId:changed.draft.id,expectedVersion:changed.draft.version})));
  await requests.submit(owner,deletion(second));
  expect(await db.query('SELECT version FROM template_versions WHERE template_id=$1 ORDER BY version',[id])).toEqual([{version:1}]);
  expect((await getPlanTemplate(db,owner,plan.planId,today)).definition).toEqual(plan.definition);
  await execute(db,ctx,randomUUID(),[{type:'add_generic_record',planId:plan.planId,values:{date:today,amountMl:200}}]);
  expect(await db.query('SELECT id FROM records WHERE plan_id=$1',[plan.planId])).toHaveLength(2);
  await expect(execute(db,ctx,randomUUID(),[{type:'adopt_template',templateId:id,templateVersion:1}])).rejects.toMatchObject({code:'not_found'});
  await expect(requests.submit(owner,request({action:'fork',sourcePlanId:plan.planId}))).rejects.toMatchObject({code:'not_found'});
 });
 it('明确确认、版本与跨账号保护，篡改delete内容不得重放',async()=>{
  const owner=await user(),other=await user(),s=await saved(owner),del=deletion(s.result);
  expect(()=>creationRequestBody.parse({...del,confirmDelete:false})).toThrow();
  await expect(requests.submit(other,del)).rejects.toMatchObject({code:'not_found'});
  await expect(requests.submit(owner,{...del,expectedVersion:1} as typeof del)).rejects.toMatchObject({code:'version_conflict'});
  expect((await getCreationDraft(db,owner,s.result.draft.id)).version).toBe(s.result.draft.version);
  await requests.submit(owner,del);expect(await requests.lookup(other,del.clientOpId)).toEqual({status:'not_found'});
  await expect(requests.submit(owner,{...del,expectedVersion:1} as typeof del)).rejects.toMatchObject({code:'operation_changed'});
  await expect(requests.submit(owner,{...s.original,action:'fork',sourceTemplateId:'official.water',sourceTemplateVersion:1})).rejects.toMatchObject({code:'operation_changed'});
 });
 for(const mode of ['proposal','provider_error'] as const)it(`删除fence在途AI ${mode}，晚返回不恢复草稿或旧响应`,async()=>{
  const owner=await user(),s=await saved(owner);let release!:(v:AiResult)=>void,reject!:(error:unknown)=>void,started!:()=>void;
  const entered=new Promise<void>(r=>{started=r;});
  const model:CreationLlm={generate:async()=>{started();return new Promise<AiResult>((res,rej)=>{release=res;reject=rej;});}};
  const coordinator=new CreationRequests(db,model,null,()=>at);
  const msg=request({action:'message',draftId:s.result.draft.id,expectedVersion:s.result.draft.version,text:'修改私人描述'});
  const pending=coordinator.submit(owner,msg);const outcome=pending.catch(e=>e);await entered;
  await requests.submit(owner,deletion(s.result));
  if(mode==='proposal')release({kind:'proposal',reply:'已调整',definition:creationDefinitionBodySchema.parse({...s.body,description:'晚响应内容'}),latencyMs:1});else reject(new LlmError('timeout'));
  expect(await outcome).toMatchObject({code:'not_found'});
  expect(await coordinator.lookup(owner,msg.clientOpId)).toEqual({status:'not_found'});
  await expect(coordinator.submit(owner,msg)).rejects.toMatchObject({code:'not_found'});
  expect(await db.query('SELECT id FROM creation_drafts WHERE user_id=$1',[owner])).toHaveLength(0);
  expect(await db.query('SELECT client_op_id FROM creation_requests WHERE user_id=$1',[owner])).toHaveLength(1);
 });
 it('删除派生草稿清除旧fork回执，原始私人模板仍可使用',async()=>{
  const owner=await user(),s=await saved(owner),fork=request({action:'fork',sourceTemplateId:s.result.draft.savedTemplate!.id,sourceTemplateVersion:1});
  const copied=draft(await requests.submit(owner,fork));await requests.submit(owner,deletion(copied));
  await expect(requests.submit(owner,fork)).rejects.toMatchObject({code:'not_found'});
  expect((await getPrivateTemplate(db,owner,s.result.draft.savedTemplate!.id)).version).toBe(1);
 });
 it('删除与修改并发只允许匹配版本先完成者提交',async()=>{
  const owner=await user(),s=await saved(owner);
  const results=await Promise.allSettled([requests.submit(owner,deletion(s.result)),requests.submit(owner,request({action:'update',draftId:s.result.draft.id,expectedVersion:s.result.draft.version,definition:{...s.body,description:'并发修改'}}))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const rows=await db.query('SELECT id FROM creation_drafts WHERE user_id=$1',[owner]);
  expect(rows.length).toBe(results[0]!.status==='fulfilled'?0:1);
 });
});
