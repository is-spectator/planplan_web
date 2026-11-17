import { randomUUID } from 'node:crypto';
import { beforeAll,afterAll,describe,expect,it } from 'vitest';
import { unzipSync,strFromU8 } from 'fflate';
import type { Db } from '../src/db/db.js';
import { openTestDb } from './database.js';
import { createCreationDraft,updateCreationDraft,saveCreationDraft,deleteCreationDraft } from '../src/services/creation-drafts.js';
import { getAvailableTemplate,getPlanTemplate } from '../src/services/templates.js';
import { execute } from '../src/services/engine.js';
import { requestAccountDeletion } from '../src/services/deletion.js';
import { buildExport } from '../src/services/export.js';
import { CommunityRequests,communityRequestBody } from '../src/services/community-requests.js';
import { getCommunityTemplate,getAdoptableCommunityTemplate,listCommunityTemplates,listAuthorCommunity,listCommunityReviewQueue,getCommunitySubmission,getCommunityOrigin,getCommunityUpgrade,registerCommunityAdoption,getPublicationEligibility,listCommunityReports,getCommunityHistory } from '../src/services/community.js';
import type { CommunityResult } from '../src/services/community-contracts.js';
const today='2026-11-16',at=new Date(`${today}T04:00:00Z`);
let db:Db,reviewer:string,requests:CommunityRequests;
beforeAll(async()=>{db=await openTestDb();reviewer=await account();requests=new CommunityRequests(db,{reviewerUserIds:new Set([reviewer]),now:()=>at});});
afterAll(async()=>{await db.close();});
async function account(){const [user]=await db.query<{id:string}>('INSERT INTO users(dev_name) VALUES($1) RETURNING id',[`community-${randomUUID()}`]);return user!.id;}
const send=(user:string,body:Record<string,unknown>,coordinator=requests)=>coordinator.submit(user,communityRequestBody.parse({clientOpId:randomUUID(),...body}));
async function source(user:string,options:{fork?:boolean;defaults?:boolean}={}){
 return db.tx(async q=>{const d=await createCreationDraft(q,user,options.fork?{sourceTemplateId:'official.water',sourceTemplateVersion:1}:undefined);
 const {name,description,configurationFields,recordFields,metrics,components,example}=await getAvailableTemplate(q,'official.water');
 const body={name,description,configurationFields,recordFields,metrics,components,example:{config:{...example.config,startDate:today},record:{...example.record,date:today,note:'私人示例绝不公开'}},...(options.defaults?{configurationDefaults:{dailyGoalMl:5197},recordDefaults:{note:'私人默认备注'}}:{})};
 const changed=await updateCreationDraft(q,user,d.id,d.version,body);return saveCreationDraft(q,user,d.id,changed.version);},user);
}
async function preview(user:string,saved:Awaited<ReturnType<typeof source>>,extra:Record<string,unknown>={}){return send(user,{action:'preview',sourceTemplateId:saved.savedTemplate!.id,sourceTemplateVersion:saved.savedTemplate!.version,title:'每日饮水',description:'记录饮水并查看目标。',authorName:'测试创作者',category:'health',...extra});}
async function submit(user:string,p:CommunityResult){return send(user,{action:'submit',previewId:p.preview!.id,publicHash:p.preview!.publicHash,confirmPublic:true});}
async function approve(s:CommunityResult){return send(reviewer,{action:'review',submissionId:s.submission!.id,expectedVersion:s.submission!.version,decision:'approve'});}
async function publish(user:string,s:CommunityResult){return send(user,{action:'publish',listingId:s.listing!.id,expectedVersion:s.listing!.version,submissionId:s.submission!.id,confirmPublic:true});}
async function published(){const owner=await account(),saved=await source(owner),p=await preview(owner,saved),submitted=await submit(owner,p),reviewed=await approve(submitted),result=await publish(owner,reviewed);return {owner,saved,result};}
async function adopted(user:string,result:CommunityResult){const ctx={userId:user,inputAt:at,source:'form' as const,genericCapability:true,privateTemplateCapability:true,communityTemplateCapability:true,genericTemplateV2Capability:true};const operation=await execute(db,ctx,randomUUID(),[{type:'adopt_template',templateId:result.listing!.templateId,templateVersion:result.listing!.templateVersion!}]);const state=operation.templatePlan!;await db.tx(q=>registerCommunityAdoption(q,user,state.planId,state.definition),user);return {ctx,state};}

describe('S3 社区发布、审核、不可变快照与账号边界',()=>{
 it('作者和审核者查看同作品申请/状态历史，分页且不包含采用者数据',async()=>{
  const c=await published(),consumer=await account(),plan=await adopted(consumer,c.result);
  await execute(db,plan.ctx,randomUUID(),[{type:'add_generic_record',planId:plan.state.planId,values:{date:today,amountMl:987,note:'采用者秘密'}}]);
  const unlisted=await send(c.owner,{action:'unlist',listingId:c.result.listing!.id,expectedVersion:c.result.listing!.version});
  await publish(c.owner,{...unlisted,submission:c.result.submission});
  const history=await getCommunityHistory(db,c.owner,c.result.listing!.id);
  expect(history.totalSubmissions).toBe(1);expect(history.totalEvents).toBe(5);
  expect(history.events.map(e=>e.kind).sort()).toEqual(['approved','published','published','submitted','unlisted'].sort());
  expect(history.submissions[0]?.payload.definition.source).toBe('community');
  const text=JSON.stringify(history);expect(text).not.toContain(consumer);expect(text).not.toContain(plan.state.planId);expect(text).not.toContain('采用者秘密');expect(text).not.toContain('"amountMl":987');
  expect(await getCommunityHistory(db,reviewer,c.result.listing!.id,new Set([reviewer]))).toEqual(history);
  await expect(getCommunityHistory(db,consumer,c.result.listing!.id)).rejects.toMatchObject({code:'not_found'});
  const page=await getCommunityHistory(db,c.owner,c.result.listing!.id,new Set(),{limit:2,offset:1});expect(page.events).toHaveLength(2);expect(page.totalEvents).toBe(5);
  await expect(getCommunityHistory(db,c.owner,c.result.listing!.id,new Set(),{limit:101})).rejects.toMatchObject({code:'invalid_input'});
 });
 it('删除私人创作不更改独立社区快照和已采用计划',async()=>{
  const c=await published(),before=await getCommunityTemplate(db,c.result.listing!.id),consumer=await account(),plan=await adopted(consumer,c.result);
  await db.tx(q=>deleteCreationDraft(q,c.owner,c.saved.id,c.saved.version),c.owner);
  expect(await getCommunityTemplate(db,c.result.listing!.id)).toMatchObject({definition:before.definition});
  expect((await getPlanTemplate(db,consumer,plan.state.planId,today)).definition).toEqual(before.definition);
  expect((await getCommunityHistory(db,c.owner,c.result.listing!.id)).submissions[0]?.payload.definition).toEqual(before.definition);
  await expect(getPublicationEligibility(db,c.owner,c.saved.savedTemplate!.id)).rejects.toMatchObject({code:'not_found'});
 });
 it('公开预览替换私人示例与默认答案，不产生计划、记录或公开版本',async()=>{
  const user=await account(),saved=await source(user,{defaults:true});const p=await preview(user,saved);
  expect(JSON.stringify(p.preview!.payload)).not.toContain('私人示例');expect(JSON.stringify(p.preview!.payload)).not.toContain('私人默认');expect(JSON.stringify(p.preview!.payload)).not.toContain('5197');
  expect(p.preview!.payload.definition).toMatchObject({source:'community',example:{record:{note:'示例文本'}}});
  expect(p.preview!.payload.definition).not.toHaveProperty('configurationDefaults');expect(p.preview!.payload.definition).not.toHaveProperty('recordDefaults');
  expect(await db.query('SELECT id FROM plans WHERE user_id=$1',[user])).toHaveLength(0);expect(await db.query('SELECT id FROM records WHERE user_id=$1',[user])).toHaveLength(0);
  expect(await db.query('SELECT template_id FROM template_versions WHERE template_id=$1',[p.listing!.templateId])).toHaveLength(0);
 });
 it('只有显式确认的publicDefaults可公开，结构与示例秘密会被拒绝',async()=>{
  const user=await account(),saved=await source(user,{defaults:true});const p=await preview(user,saved,{publicDefaults:{configuration:{dailyGoalMl:1500},record:{note:'公开建议'}}});
  expect(p.preview!.payload.definition).toMatchObject({configurationDefaults:{dailyGoalMl:1500},recordDefaults:{note:'公开建议'}});
  for(const value of ['person@example.test','sk-or-v1-synthetic-secret','北京市朝阳区示例路88号','https://external.test'])await expect(preview(user,saved,{listingId:p.listing!.id,expectedVersion:p.listing!.version,description:value})).rejects.toMatchObject({code:'invalid_input'});
 });
 it('身份、公开确认与原内容hash不可由客户端伪造',async()=>{
  const a=await account(),b=await account(),saved=await source(a);await expect(preview(b,saved)).rejects.toMatchObject({code:'not_found'});
  const p=await preview(a,saved);await expect(send(a,{action:'submit',previewId:p.preview!.id,publicHash:'0'.repeat(64),confirmPublic:true})).rejects.toMatchObject({code:'operation_changed'});
  expect(()=>communityRequestBody.parse({clientOpId:randomUUID(),action:'submit',previewId:p.preview!.id,publicHash:p.preview!.publicHash,confirmPublic:false})).toThrow();
  await expect(submit(b,p)).rejects.toMatchObject({code:'not_found'});
 });
 it('派生作品及未知旧来源默认禁止发布',async()=>{
  const user=await account(),fork=await source(user,{fork:true});expect(await getPublicationEligibility(db,user,fork.savedTemplate!.id)).toMatchObject({canPublish:false});await expect(preview(user,fork)).rejects.toMatchObject({code:'invalid_input'});
  const original=await source(user);await db.query('UPDATE creation_drafts SET publish_eligible=false WHERE id=$1',[original.id]);expect(await getPublicationEligibility(db,user,original.savedTemplate!.id)).toMatchObject({canPublish:false});
 });
 it('未审核与approved都不能选用；作者显式publish后才能搜到',async()=>{
  const user=await account(),saved=await source(user),p=await preview(user,saved),s=await submit(user,p);
  await expect(getCommunityTemplate(db,p.listing!.templateId)).rejects.toMatchObject({code:'not_found'});
  await expect(send(user,{action:'review',submissionId:s.submission!.id,expectedVersion:s.submission!.version,decision:'approve'})).rejects.toMatchObject({code:'forbidden'});
  const approved=await approve(s);expect(approved.submission!.status).toBe('approved');await expect(getAdoptableCommunityTemplate(db,p.listing!.templateId)).rejects.toMatchObject({code:'not_found'});
  const result=await publish(user,approved);const detail=await getCommunityTemplate(db,result.listing!.templateId);expect(detail.source).toBe('community');expect(detail.author).toEqual({kind:'community',name:'测试创作者'});
  const list=await listCommunityTemplates(db,{q:'饮水',category:'health',sort:'popular',limit:100});expect(list.templates.some(t=>t.templateId===detail.templateId)).toBe(true);expect(JSON.stringify(detail)).not.toContain(user);
 });
 it('审核者不能自审；驳回理由与重新提审版本可追溯',async()=>{
  const own=await source(reviewer),p=await preview(reviewer,own),self=await submit(reviewer,p);await expect(approve(self)).rejects.toMatchObject({code:'forbidden'});
  const user=await account(),saved=await source(user),one=await submit(user,await preview(user,saved));const rejected=await send(reviewer,{action:'review',submissionId:one.submission!.id,expectedVersion:1,decision:'reject',reason:'请补充明确用途。'});
  expect((await getCommunitySubmission(db,user,one.submission!.id)).rejectionReason).toBe('请补充明确用途。');
  const second=await submit(user,await preview(user,saved,{listingId:rejected.listing!.id,expectedVersion:rejected.listing!.version,description:'记录每日饮水量并查看当日目标。'}));expect(second.submission!.id).not.toBe(one.submission!.id);expect(second.submission!.status).toBe('pending');
  await expect(listCommunityReviewQueue(db,user,new Set([reviewer]))).rejects.toMatchObject({code:'forbidden'});
 });
 it('同ID同体恢复完全同结果，异体拒绝；过期预览不得新提交',async()=>{
  const user=await account(),saved=await source(user),id=randomUUID();const body={clientOpId:id,action:'preview',sourceTemplateId:saved.savedTemplate!.id,sourceTemplateVersion:1,title:'恢复测试',description:'用于验证恢复',authorName:'测试作者',category:'life'};
  const first=await send(user,body);expect(await send(user,body)).toEqual(first);expect(await requests.lookup(user,id)).toEqual({status:'succeeded',result:first});expect(await requests.lookup(await account(),id)).toEqual({status:'not_found'});
  await expect(send(user,{...body,title:'变更内容'})).rejects.toMatchObject({code:'operation_changed'});
  const late=new CommunityRequests(db,{reviewerUserIds:new Set([reviewer]),now:()=>new Date(at.getTime()+31*60_000)});await expect(send(user,{action:'submit',previewId:first.preview!.id,publicHash:first.preview!.publicHash,confirmPublic:true},late)).rejects.toMatchObject({code:'confirmation_expired'});
 });
 it('公开版本不可变；新版审核中不改变正在上架的版本',async()=>{
  const c=await published();await expect(db.query("UPDATE template_versions SET definition=definition WHERE template_id=$1",[c.result.listing!.templateId])).rejects.toThrow();
  const p=await preview(c.owner,c.saved,{listingId:c.result.listing!.id,expectedVersion:c.result.listing!.version,title:'新版每日饮水'});await submit(c.owner,p);expect((await getCommunityTemplate(db,c.result.listing!.templateId)).title).toBe('每日饮水');
  await expect(db.query("UPDATE community_submissions SET public_payload='{}'::jsonb WHERE id=$1",[c.result.submission!.id])).rejects.toThrow();
 });
 it('两个使用者得到独立计划，累计选用只统计真实实例且不泄露其明细',async()=>{
  const c=await published(),a=await account(),b=await account(),one=await adopted(a,c.result),two=await adopted(b,c.result);expect(one.state.planId).not.toBe(two.state.planId);
  await execute(db,one.ctx,randomUUID(),[{type:'add_generic_record',planId:one.state.planId,values:{date:today,amountMl:500,note:'使用者甲私人记录'}}]);
  await execute(db,two.ctx,randomUUID(),[{type:'add_generic_record',planId:two.state.planId,values:{date:today,amountMl:300}}]);
  expect((await getCommunityTemplate(db,c.result.listing!.templateId)).adoptionCount).toBe(2);const owner=await listAuthorCommunity(db,c.owner);expect(JSON.stringify(owner)).not.toContain('使用者甲私人记录');expect(JSON.stringify(owner)).not.toContain(one.state.planId);
  await expect(getPlanTemplate(db,c.owner,one.state.planId,today)).rejects.toMatchObject({code:'not_found'});
 });
 it('作者下架阻止新选用，既有实例继续读写；审核暂停不可由作者解除',async()=>{
  const c=await published(),user=await account(),plan=await adopted(user,c.result);const hidden=await send(c.owner,{action:'unlist',listingId:c.result.listing!.id,expectedVersion:c.result.listing!.version});
  await expect(getAdoptableCommunityTemplate(db,c.result.listing!.templateId)).rejects.toMatchObject({code:'not_found'});
  await execute(db,plan.ctx,randomUUID(),[{type:'add_generic_record',planId:plan.state.planId,values:{date:today,amountMl:100}}]);expect((await getPlanTemplate(db,user,plan.state.planId,today)).source).toBe('community');
  const paused=await send(reviewer,{action:'suspend',listingId:hidden.listing!.id,expectedVersion:hidden.listing!.version,reason:'内容需要核对。'});await expect(send(c.owner,{action:'restore',listingId:paused.listing!.id,expectedVersion:paused.listing!.version})).rejects.toMatchObject({code:'forbidden'});
 });
 it('作者明确重新上架可复用同版，审核暂停必须先由审核者解除',async()=>{
  const c=await published();
  const pending=await submit(c.owner,await preview(c.owner,c.saved,{listingId:c.result.listing!.id,expectedVersion:c.result.listing!.version}));
  const rejected=await send(reviewer,{action:'review',submissionId:pending.submission!.id,expectedVersion:pending.submission!.version,decision:'reject',reason:'补充新版本说明。'});
  expect(rejected.listing!.latestSubmission!.status).toBe('rejected');expect(rejected.listing!.publishedSubmissionId).toBe(c.result.submission!.id);
  const hidden=await send(c.owner,{action:'unlist',listingId:c.result.listing!.id,expectedVersion:rejected.listing!.version});
  const listed=await publish(c.owner,{...hidden,submission:c.result.submission});expect(listed.listing!.templateVersion).toBe(1);
  expect(await db.query('SELECT version FROM template_versions WHERE template_id=$1',[listed.listing!.templateId])).toHaveLength(1);
  const paused=await send(reviewer,{action:'suspend',listingId:listed.listing!.id,expectedVersion:listed.listing!.version,reason:'暂停核对'});
  await expect(publish(c.owner,{...paused,submission:c.result.submission})).rejects.toMatchObject({code:'forbidden'});
  const restored=await send(reviewer,{action:'restore',listingId:paused.listing!.id,expectedVersion:paused.listing!.version});expect(restored.listing!.status).toBe('unlisted');
  expect((await publish(c.owner,{...restored,submission:c.result.submission})).listing!.status).toBe('listed');
 });
 it('普通模板新增显式公开默认值时自动声明新版能力',async()=>{
  const owner=await account(),saved=await source(owner),p=await preview(owner,saved,{publicDefaults:{configuration:{dailyGoalMl:1000}}});
  expect(p.preview!.payload.definition.requiredCapabilities).toContain('generic-template-v2');
 });
 it('举报只向审核者开放；处理暂停作品并保留使用者计划',async()=>{
  const c=await published(),reporter=await account();const report=await send(reporter,{action:'report',listingId:c.result.listing!.id,templateVersion:1,reason:'misleading',details:'公开说明与记录项目不符。'});
  expect(report).not.toHaveProperty('listing');await expect(listCommunityReports(db,c.owner,new Set([reviewer]))).rejects.toMatchObject({code:'forbidden'});
  const result=await send(reviewer,{action:'resolve_report',reportId:report.report!.id,expectedVersion:1,resolution:'actioned',reason:'先暂停并核对说明。',expectedListingVersion:c.result.listing!.version});expect(result.report!.status).toBe('actioned');await expect(getCommunityTemplate(db,c.result.listing!.templateId)).rejects.toMatchObject({code:'not_found'});
 });
 it('兼容升级预览保留旧快照与配置，拒绝破坏性字段变更',async()=>{
  const c=await published(),user=await account(),plan=await adopted(user,c.result);
  const draft=await db.tx(async q=>{const old=c.saved.definition!;const {name,description,configurationFields,recordFields,metrics,components,example}=old;const changed=await updateCreationDraft(q,c.owner,c.saved.id,c.saved.version,{name,description,configurationFields,recordFields:[...recordFields,{id:'weather',label:'天气',type:'text',required:false,maxLength:20}],metrics,components,example});return saveCreationDraft(q,c.owner,c.saved.id,changed.version);},c.owner);
  const next=await publish(c.owner,await approve(await submit(c.owner,await preview(c.owner,draft,{listingId:c.result.listing!.id,expectedVersion:c.result.listing!.version}))));
  const upgrade=await getCommunityUpgrade(db,user,plan.state.planId,next.listing!.templateVersion!);expect(upgrade.changes).toContain('新增可选项目「天气」');expect((await getPlanTemplate(db,user,plan.state.planId,today)).templateVersion).toBe(1);
  await expect(getAdoptableCommunityTemplate(db,c.result.listing!.templateId,1)).rejects.toMatchObject({code:'version_conflict'});
  await expect(getCommunityUpgrade(db,user,plan.state.planId,1)).rejects.toMatchObject({code:'invalid_input'});
  const incompatible=await db.tx(async q=>{const old=draft.definition!;const {name,description,configurationFields,recordFields,metrics,components,example}=old;const {note:_note,...record}=example.record;const changed=await updateCreationDraft(q,c.owner,draft.id,draft.version,{name,description,configurationFields,recordFields:recordFields.filter(field=>field.id!=='note'),metrics,components,example:{config:example.config,record}});return saveCreationDraft(q,c.owner,draft.id,changed.version);},c.owner);
  const broken=await publish(c.owner,await approve(await submit(c.owner,await preview(c.owner,incompatible,{listingId:next.listing!.id,expectedVersion:next.listing!.version}))));
  await expect(getCommunityUpgrade(db,user,plan.state.planId,broken.listing!.templateVersion!)).rejects.toMatchObject({code:'invalid_input'});
  expect((await getPlanTemplate(db,user,plan.state.planId,today)).templateVersion).toBe(1);

 });
 it('作者删除清除身份/草稿/申请，使用者定义来源和真实记录继续可写可导出',async()=>{
  const c=await published(),user=await account(),plan=await adopted(user,c.result);await execute(db,plan.ctx,randomUUID(),[{type:'add_generic_record',planId:plan.state.planId,values:{date:today,amountMl:888,note:'只属于使用者'}}]);
  const before=(await db.query<{fields:unknown}>('SELECT fields FROM records WHERE plan_id=$1',[plan.state.planId]))[0];
  expect((await db.query('SELECT client_op_id FROM community_requests WHERE user_id=$1 AND subject_user_id=$2',[reviewer,c.owner])).length).toBeGreaterThan(0);
  expect((await requestAccountDeletion(db,c.owner)).status).toBe('completed');expect((await getCommunityOrigin(db,c.result.listing!.templateId)).author).toEqual({kind:'deleted',name:'匿名作者'});
  expect(await db.query('SELECT client_op_id FROM community_requests WHERE subject_user_id=$1',[c.owner])).toHaveLength(0);
  expect(await db.query('SELECT id FROM community_submissions WHERE owner_user_id=$1',[c.owner])).toHaveLength(0);expect(await db.query('SELECT id FROM creation_drafts WHERE user_id=$1',[c.owner])).toHaveLength(0);
  expect((await db.query<{fields:unknown}>('SELECT fields FROM records WHERE plan_id=$1',[plan.state.planId]))[0]).toEqual(before);
  await execute(db,plan.ctx,randomUUID(),[{type:'add_generic_record',planId:plan.state.planId,values:{date:today,amountMl:100}}]);
  const zip=unzipSync(await buildExport(db,user));expect(strFromU8(zip['generic-records.json']!)).toContain('888');expect(strFromU8(zip['community.json']!)).not.toContain('测试创作者');
  expect((await db.query<{owner_user_id:string|null}>('SELECT owner_user_id FROM template_versions WHERE template_id=$1',[c.result.listing!.templateId]))[0]!.owner_user_id).toBeNull();
 });
});
