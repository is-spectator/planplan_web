import { createHash } from 'node:crypto';
import type { Queryable,Transaction } from '../db/db.js';
import { templateDefinitionSchema,type TemplateDefinition,type TemplateField } from '../templates/contracts.js';
import { requireGenericDefinition } from './generic.js';
import { requireActiveUser } from './deletion.js';
import { fail } from './errors.js';
import type { BizDate } from '../domain/time.js';
import type { CommunityCategory,CommunityListing,CommunityPaging,CommunityPreview,CommunityReport,CommunityRequest,CommunitySubmission,CommunityTemplate,PublicCommunityPayload,CommunityHistory,CommunityHistoryEvent } from './community-contracts.js';
export * from './community-contracts.js';

export const communityCanonical=(v:unknown):unknown=>Array.isArray(v)?v.map(communityCanonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,communityCanonical(value)])):v;
export const communityHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(communityCanonical(v))).digest('hex');
const iso=(v:Date|string)=>new Date(v).toISOString();
const templateId=(id:string)=>`community.${id}`;
const listingId=(id:string)=>{const value=id.startsWith('community.')?id.slice(10):id;if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))return fail('not_found','这个社区模板暂时无法使用。');return value;};
const pagination=(options:CommunityPaging={})=>{const limit=options.limit??20,offset=options.offset??0;if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>10000)fail('invalid_input','分页范围不正确。');return {limit,offset};};
export function requireCommunityReviewer(userId:string,reviewerUserIds:ReadonlySet<string>){if(!reviewerUserIds.has(userId))return fail('forbidden','当前账户没有审核权限。');}
export function checkCommunityPublicText(value:unknown):void {
 if(typeof value==='string') {
  if(/(?:sk-(?:or-v\d-|proj-)|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[\w.+/=-]{16,}|AKIA[A-Z0-9]{16}|eyJ[\w-]{12,}\.[\w-]{12,}\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|(?:\+?86[- ]?)?1[3-9]\d{9}|[\u4e00-\u9fff]{2,}(?:省|市|区).{0,20}(?:路|街|巷).{0,20}(?:号|室))/iu.test(value))fail('invalid_input','公开内容中可能包含邮箱、地址、密钥或外部链接，请清除私人信息后重新预览。');
 } else if(Array.isArray(value))value.forEach(checkCommunityPublicText);
 else if(value&&typeof value==='object')Object.values(value).forEach(checkCommunityPublicText);
}
function checkCommunityPublicPayload(payload:PublicCommunityPayload,id:string):void {
 // Only this server-issued identity is metadata. Never skip arbitrary UUID-shaped
 // strings or user-controlled field IDs/defaults when checking public content.
 if(payload.definition.id!==templateId(id)||payload.definition.source!=='community')return fail('invalid_input','公开模板身份不正确。');
 const {id:_serverTemplateId,...definition}=payload.definition;
 checkCommunityPublicText({...payload,definition});
}
type ListingRow={id:string;owner_user_id:string|null;source_template_id:string|null;version:number;status:CommunityListing['status'];title:string|null;description:string|null;category:CommunityCategory|null;author_name:string|null;recommended_version:number|null;moderation_reason:string|null;created_at:Date;updated_at:Date;published_at:Date|null};
type SubmissionRow={id:string;owner_user_id:string;listing_id:string;version:number;status:CommunitySubmission['status'];public_payload:PublicCommunityPayload;public_hash:string;rejection_reason:string|null;published_version:number|null;created_at:Date;updated_at:Date};
type PreviewRow={id:string;owner_user_id:string;listing_id:string;listing_version:number;source_template_id:string;source_template_version:number;public_payload:PublicCommunityPayload;public_hash:string;expires_at:Date};
type ReportRow={id:string;reporter_user_id:string;listing_id:string;template_version:number;version:number;reason:CommunityReport['reason'];details:string;status:CommunityReport['status'];resolution_reason:string|null;created_at:Date;updated_at:Date};
const submissionView=(r:SubmissionRow):CommunitySubmission=>({id:r.id,listingId:r.listing_id,version:r.version,status:r.status,payload:r.public_payload,rejectionReason:r.rejection_reason,publishedVersion:r.published_version,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)});
const reportView=(r:ReportRow):CommunityReport=>({id:r.id,listingId:r.listing_id,templateVersion:r.template_version,version:r.version,reason:r.reason,details:r.details,status:r.status,resolutionReason:r.resolution_reason,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)});
const previewView=(r:PreviewRow):CommunityPreview=>({id:r.id,listingId:r.listing_id,listingVersion:r.listing_version,publicHash:r.public_hash,expiresAt:iso(r.expires_at),payload:r.public_payload});
async function lockedListing(q:Queryable,id:string){const [r]=await q.query<ListingRow>('SELECT * FROM community_listings WHERE id=$1 FOR UPDATE',[id]);return r??fail('not_found','没有找到这个作品。');}
function author(r:ListingRow,userId:string){if(r.owner_user_id!==userId)return fail('not_found','没有找到这个作品。');}
function version(actual:number,expected:number){if(actual!==expected)return fail('version_conflict','内容已在其他页面变化，请核对最新状态后继续。');}
async function bump(q:Queryable,id:string){await q.query('UPDATE community_listings SET version=version+1,updated_at=now() WHERE id=$1',[id]);}
async function adoptionCount(q:Queryable,id:string){return (await q.query<{n:number}>('SELECT count(*)::int AS n FROM community_adoptions WHERE listing_id=$1',[id]))[0]!.n;}
async function listingView(q:Queryable,r:ListingRow):Promise<CommunityListing>{const [latest]=await q.query<SubmissionRow>('SELECT * FROM community_submissions WHERE listing_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[r.id]);const [published]=await q.query<{submission_id:string|null}>('SELECT submission_id FROM community_publications WHERE listing_id=$1 AND template_version=$2',[r.id,r.recommended_version]);return {id:r.id,templateId:templateId(r.id),version:r.version,status:r.status,title:r.title??'已下架作品',description:r.description??'',category:r.category,author:{kind:r.owner_user_id?'community':'deleted',name:r.owner_user_id?r.author_name??'创作者':'匿名作者'},templateVersion:r.recommended_version,adoptionCount:await adoptionCount(q,r.id),moderationReason:r.moderation_reason,publishedSubmissionId:published?.submission_id??null,latestSubmission:latest?submissionView(latest):null,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)};}
export async function getAuthorCommunityListing(q:Queryable,userId:string,id:string){const [r]=await q.query<ListingRow>('SELECT * FROM community_listings WHERE id=$1 AND owner_user_id=$2',[id,userId]);if(!r)return fail('not_found','没有找到这个作品。');return listingView(q,r);}
export async function listAuthorCommunity(q:Queryable,userId:string,options:CommunityPaging={}){await requireActiveUser(q,userId);const {limit,offset}=pagination(options);const [count]=await q.query<{n:number}>('SELECT count(*)::int AS n FROM community_listings WHERE owner_user_id=$1',[userId]);const rows=await q.query<ListingRow>('SELECT * FROM community_listings WHERE owner_user_id=$1 ORDER BY updated_at DESC,id LIMIT $2 OFFSET $3',[userId,limit,offset]);return {listings:await Promise.all(rows.map(r=>listingView(q,r))),total:count!.n};}
export async function listCommunityTemplates(q:Queryable,options:CommunityPaging&{q?:string;category?:CommunityCategory;sort?:'recent'|'popular'}={}) {
 const {limit,offset}=pagination(options),search=(options.q??'').trim();if(search.length>80)fail('invalid_input','搜索内容最多80字。');
 const params=[`%${search.replace(/[\\%_]/g,'\\$&')}%`,options.category??null];
 const where="l.status='listed' AND u.deleted_at IS NULL AND (l.title ILIKE $1 ESCAPE '\\' OR l.description ILIKE $1 ESCAPE '\\') AND ($2::text IS NULL OR l.category=$2)";
 const [count]=await q.query<{n:number}>(`SELECT count(*)::int AS n FROM community_listings l JOIN users u ON u.id=l.owner_user_id WHERE ${where}`,params);
 const rows=await q.query<ListingRow&{definition:unknown;uses:number}>(`SELECT l.*,v.definition,(SELECT count(*)::int FROM community_adoptions a WHERE a.listing_id=l.id) AS uses FROM community_listings l JOIN users u ON u.id=l.owner_user_id JOIN template_versions v ON v.template_id='community.'||l.id::text AND v.version=l.recommended_version WHERE ${where} ORDER BY ${options.sort==='popular'?'uses DESC,':''}l.published_at DESC,l.id LIMIT $3 OFFSET $4`,[...params,limit,offset]);
 return {templates:rows.map(r=>publicView(r,requireGenericDefinition(r.definition),r.uses)),total:count!.n};
}
function publicView(r:ListingRow,definition:TemplateDefinition,uses:number):CommunityTemplate{return {id:r.id,templateId:definition.id,source:'community',title:r.title!,description:r.description!,category:r.category!,author:{kind:'community',name:r.author_name!},templateVersion:definition.version,adoptionCount:uses,definition,publishedAt:iso(r.published_at!)};}
export async function getAdoptableCommunityTemplate(q:Queryable,id:string,requestedVersion?:number):Promise<TemplateDefinition>{
 const row=await lockedListing(q,listingId(id));
 if(row.status!=='listed'||!row.owner_user_id||!row.recommended_version)return fail('not_found','这个社区模板已下架或尚未上架，已有计划仍可继续使用。');
 const [owner]=await q.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL',[row.owner_user_id]);if(!owner)return fail('not_found','这个社区模板暂时无法选用，已有计划仍可继续使用。');
 if(requestedVersion!==undefined&&requestedVersion!==row.recommended_version)return fail('version_conflict','模板已有新的可选用版本，请重新打开后核对。');
 const [stored]=await q.query<{definition:unknown}>('SELECT definition FROM template_versions WHERE template_id=$1 AND version=$2 AND owner_user_id IS NULL',[templateId(row.id),row.recommended_version]);
 if(!stored)return fail('not_found','这个社区模板暂时无法使用。');return requireGenericDefinition(stored.definition);
}
export async function getCommunityTemplate(q:Queryable,id:string,requestedVersion?:number){const definition=await getAdoptableCommunityTemplate(q,id,requestedVersion);const [r]=await q.query<ListingRow>('SELECT * FROM community_listings WHERE id=$1',[listingId(id)]);return publicView(r!,definition,await adoptionCount(q,r!.id));}
export async function registerCommunityAdoption(q:Queryable,userId:string,planId:string,definition:TemplateDefinition){
 if(definition.source!=='community')return;
 const current=await getAdoptableCommunityTemplate(q,definition.id,definition.version);
 const [owned]=await q.query('SELECT p.id FROM plans p JOIN plan_template_bindings b ON b.plan_id=p.id WHERE p.id=$1 AND p.user_id=$2 AND b.template_id=$3 AND b.template_version=$4',[planId,userId,current.id,current.version]);
 if(!owned)return fail('invalid_input','选用结果与模板不一致。');
 await q.query('INSERT INTO community_adoptions(listing_id,template_version,plan_id) VALUES($1,$2,$3) ON CONFLICT(plan_id) DO NOTHING',[listingId(current.id),current.version,planId]);
}
export async function getCommunityOrigin(q:Queryable,id:string){const [r]=await q.query<ListingRow>('SELECT * FROM community_listings WHERE id=$1',[listingId(id)]);return {listingId:listingId(id),status:r?.status??'author_deleted',author:{kind:r?.owner_user_id?'community':'deleted',name:r?.owner_user_id?r.author_name??'创作者':'匿名作者'}};}
export async function getCommunityUpgrade(q:Queryable,userId:string,planId:string,targetVersion:number){
 const [binding]=await q.query<{definition_snapshot:TemplateDefinition;template_id:string;template_version:number;config_version:number;source:string;status:string}>('SELECT b.*,p.status FROM plan_template_bindings b JOIN plans p ON p.id=b.plan_id WHERE b.plan_id=$1 AND b.user_id=$2',[planId,userId]);
 if(!binding)return fail('not_found','没有找到这个计划。');
 if(binding.source!=='community')return fail('invalid_input','只有保持社区来源的计划可以升级；私人改编版本保持独立。');
 if(binding.status==='archived')return fail('plan_archived','请先恢复计划再升级。');
 if(targetVersion<=binding.template_version)return fail('invalid_input','请选择比当前版本更新的模板；本期不提供版本回退。');
 const next=await getAdoptableCommunityTemplate(q,binding.template_id,targetVersion),current=requireGenericDefinition(binding.definition_snapshot);
 const {assertCompatibleTemplate}=await import('./creation-drafts.js');assertCompatibleTemplate(current,next);
 const changes:string[]=[];for(const key of ['configurationFields','recordFields'] as const){for(const field of next[key]){const old=current[key].find(f=>f.id===field.id);if(!old)changes.push(`新增可选项目「${field.label}」`);else if(old.label!==field.label)changes.push(`「${old.label}」更名为「${field.label}」`);}}
 if(communityHash(current.components)!==communityHash(next.components))changes.push('调整展示顺序');
 if(current.name!==next.name||current.description!==next.description)changes.push('更新模板名称与说明');
 return {current,next,changes:changes.length?changes:['更新兼容的展示内容'],expectedVersion:binding.config_version,currentTemplateVersion:binding.template_version};
}
function syntheticValue(field:TemplateField,today:BizDate):unknown {
 if(field.type==='date')return today;if(field.type==='boolean')return true;if(field.type==='single_select')return field.options![0];if(field.type==='multi_select')return [field.options![0]];
 if(field.type==='text')return (field.id==='name'?'示例计划':'示例文本').slice(0,field.maxLength??200);
 const preferred=field.type==='money'?2000:field.type==='duration'?20:field.unit==='ml'?500:10;
 return Math.max(field.min??0,Math.min(field.max??Number.MAX_SAFE_INTEGER,preferred));
}
export function synthesizeCommunityDefinition(original:TemplateDefinition,id:string,versionNumber:number,input:Extract<CommunityRequest,{action:'preview'}>,today:BizDate):TemplateDefinition {
 const {example:_example,configurationDefaults:_config,recordDefaults:_record,...structure}=original;
 const example={config:Object.fromEntries(original.configurationFields.map(field=>[field.id,syntheticValue(field,today)])),record:Object.fromEntries(original.recordFields.map(field=>[field.id,syntheticValue(field,today)]))};
 const raw={...structure,id:templateId(id),version:versionNumber,source:'community',name:input.title,description:input.description,requiredCapabilities:[...new Set([...original.requiredCapabilities.filter(cap=>cap!=='private-template-v1'&&cap!=='community-template-v1'),...(input.publicDefaults?['generic-template-v2']:[]),'community-template-v1'])],example,...(input.publicDefaults?.configuration?{configurationDefaults:input.publicDefaults.configuration}:{}),...(input.publicDefaults?.record?{recordDefaults:input.publicDefaults.record}:{})};
 const definition=requireGenericDefinition(templateDefinitionSchema.parse(raw));
 checkCommunityPublicPayload({title:input.title,description:input.description,category:input.category,authorName:input.authorName,definition},id);
 return definition;
}
export async function createCommunityPreview(q:Transaction,userId:string,input:Extract<CommunityRequest,{action:'preview'}>,today:BizDate,now:Date):Promise<{preview:CommunityPreview;listing:CommunityListing}>{
 const [source]=await q.query<{definition:unknown;publish_eligible:boolean;source_plan_id:string|null;source_template_id:string|null}>('SELECT v.definition,d.publish_eligible,d.source_plan_id,d.source_template_id FROM template_versions v JOIN creation_drafts d ON d.template_id=v.template_id AND d.user_id=v.owner_user_id WHERE v.template_id=$1 AND v.version=$2 AND v.owner_user_id=$3',[input.sourceTemplateId,input.sourceTemplateVersion,userId]);
 if(!source)return fail('not_found','没有找到自己保存的私人模板版本。');
 if(!source.publish_eligible||source.source_plan_id||source.source_template_id)return fail('invalid_input','私人改编作品本期仅供自己使用。无法确认原创来源的旧草稿也暂不支持发布，请从新的原创草稿开始。');
 const original=requireGenericDefinition(source.definition);
 let listing:ListingRow;
 if(input.listingId){listing=await lockedListing(q,input.listingId);author(listing,userId);version(listing.version,input.expectedVersion!);if(listing.source_template_id!==input.sourceTemplateId)return fail('invalid_input','新版需要来自这个作品原来的私人模板。');}
 else {
  const [existing]=await q.query('SELECT id FROM community_listings WHERE owner_user_id=$1 AND source_template_id=$2',[userId,input.sourceTemplateId]);
  if(existing)return fail('version_conflict','这个模板已有发布作品，请从我的作品中继续发布。');
  const [created]=await q.query<ListingRow>('INSERT INTO community_listings(owner_user_id,source_template_id,title,description,category,author_name) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[userId,input.sourceTemplateId,input.title,input.description,input.category,input.authorName]);
  listing=created!;
 }
 const definition=synthesizeCommunityDefinition(original,listing!.id,(listing!.recommended_version??0)+1,input,today);
 const payload:PublicCommunityPayload={title:input.title,description:input.description,category:input.category,authorName:input.authorName,definition};
 const [preview]=await q.query<PreviewRow>('INSERT INTO community_previews(owner_user_id,listing_id,listing_version,source_template_id,source_template_version,public_payload,public_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[userId,listing!.id,listing!.version,input.sourceTemplateId,input.sourceTemplateVersion,JSON.stringify(payload),communityHash(payload),new Date(now.getTime()+30*60_000)]);
 return {preview:previewView(preview!),listing:await listingView(q,listing!)};
}
export async function submitCommunityPreview(q:Transaction,userId:string,input:Extract<CommunityRequest,{action:'submit'}>,now:Date){
 const [preview]=await q.query<PreviewRow>('SELECT * FROM community_previews WHERE id=$1 AND owner_user_id=$2',[input.previewId,userId]);if(!preview)return fail('not_found','没有找到这次发布预览。');
 const listing=await lockedListing(q,preview.listing_id);author(listing,userId);
 if(preview.public_hash!==input.publicHash||communityHash(preview.public_payload)!==input.publicHash)return fail('operation_changed','公开内容已变化，请重新预览并确认。');
 const [already]=await q.query<SubmissionRow>('SELECT * FROM community_submissions WHERE preview_id=$1',[preview.id]);if(already)return {submission:submissionView(already),listing:await listingView(q,listing)};
 if(new Date(preview.expires_at).getTime()<=now.getTime())return fail('confirmation_expired','发布预览已过期，请重新查看将公开的内容。');
 version(listing.version,preview.listing_version);
 const [pending]=await q.query('SELECT id FROM community_submissions WHERE listing_id=$1 AND status IN(\'pending\',\'approved\')',[listing.id]);if(pending)return fail('invalid_input','这个作品已有待审核或待上架版本，请先处理当前申请。');
 checkCommunityPublicPayload(preview.public_payload,listing.id);requireGenericDefinition(preview.public_payload.definition);
 const [submission]=await q.query<SubmissionRow>('INSERT INTO community_submissions(owner_user_id,listing_id,preview_id,public_payload,public_hash,source_template_id,source_template_version) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[userId,listing.id,preview.id,JSON.stringify(preview.public_payload),preview.public_hash,preview.source_template_id,preview.source_template_version]);
 await bump(q,listing.id);return {submission:submissionView(submission!),listing:await listingView(q,await lockedListing(q,listing.id))};
}
async function lockedSubmission(q:Queryable,userId:string,id:string,reviewers?:ReadonlySet<string>){
 const [identity]=await q.query<{owner_user_id:string;listing_id:string}>('SELECT owner_user_id,listing_id FROM community_submissions WHERE id=$1',[id]);
 if(!identity||identity.owner_user_id!==userId&&!reviewers?.has(userId))return fail('not_found','没有找到这次发布申请。');
 const listing=await lockedListing(q,identity.listing_id);const [submission]=await q.query<SubmissionRow>('SELECT * FROM community_submissions WHERE id=$1 FOR UPDATE',[id]);
 if(!submission||!listing.owner_user_id)return fail('not_found','这个作品已撤下。');return {listing,submission};
}
export async function reviewCommunitySubmission(q:Transaction,userId:string,input:Extract<CommunityRequest,{action:'review'}>,reviewers:ReadonlySet<string>){
 requireCommunityReviewer(userId,reviewers);const {listing,submission}=await lockedSubmission(q,userId,input.submissionId,reviewers);
 if(submission.owner_user_id===userId)return fail('forbidden','不能审核自己的作品，请由另一位审核者处理。');
 version(submission.version,input.expectedVersion);if(submission.status!=='pending')return fail('version_conflict','这次申请已处理，请查看最新状态。');
 checkCommunityPublicPayload(submission.public_payload,listing.id);requireGenericDefinition(submission.public_payload.definition);
 const status=input.decision==='approve'?'approved':'rejected';
 await q.query('UPDATE community_submissions SET status=$2,rejection_reason=$3,version=version+1,updated_at=now() WHERE id=$1',[submission.id,status,status==='rejected'?input.reason:null]);
 await q.query('INSERT INTO community_reviews(submission_id,reviewer_user_id,decision,reason) VALUES($1,$2,$3,$4)',[submission.id,userId,status,input.reason??null]);
 await bump(q,listing.id);const [next]=await q.query<SubmissionRow>('SELECT * FROM community_submissions WHERE id=$1',[submission.id]);return {submission:submissionView(next!),listing:await listingView(q,await lockedListing(q,listing.id))};
}
export async function withdrawCommunitySubmission(q:Transaction,userId:string,input:Extract<CommunityRequest,{action:'withdraw'}>){const {listing,submission}=await lockedSubmission(q,userId,input.submissionId);author(listing,userId);version(submission.version,input.expectedVersion);if(!['pending','approved'].includes(submission.status))return fail('version_conflict','这次申请已处理，无法再次撤回。');await q.query("UPDATE community_submissions SET status='withdrawn',version=version+1,updated_at=now() WHERE id=$1",[submission.id]);await bump(q,listing.id);const [next]=await q.query<SubmissionRow>('SELECT * FROM community_submissions WHERE id=$1',[submission.id]);return {submission:submissionView(next!),listing:await listingView(q,await lockedListing(q,listing.id))};}
export async function publishCommunitySubmission(q:Transaction,userId:string,input:Extract<CommunityRequest,{action:'publish'}>){
 const {listing,submission}=await lockedSubmission(q,userId,input.submissionId);author(listing,userId);if(listing.id!==input.listingId)return fail('invalid_input','申请与作品不匹配。');version(listing.version,input.expectedVersion);
 if(listing.status==='suspended')return fail('forbidden','这个作品已被暂停展示，请先完成审核处理。');
 const payload=submission.public_payload;checkCommunityPublicPayload(payload,listing.id);if(communityHash(payload)!==submission.public_hash)return fail('invalid_input','审核内容校验失败，请重新提交。');
 if(listing.status==='unlisted'&&submission.status==='published'&&submission.published_version===listing.recommended_version){
  await q.query("UPDATE community_listings SET status='listed',version=version+1,updated_at=now(),published_at=now() WHERE id=$1",[listing.id]);
  return {submission:submissionView(submission),listing:await listingView(q,await lockedListing(q,listing.id))};
 }
 if(submission.status!=='approved')return fail('invalid_input','只有审核通过的版本才能上架。');
 const nextVersion=(listing.recommended_version??0)+1;
 if(payload.definition.version!==nextVersion)return fail('version_conflict','作品版本已更新，请重新预览并提审。');
 const definition=requireGenericDefinition(payload.definition);if(definition.id!==templateId(listing.id)||definition.source!=='community')return fail('invalid_input','公开模板身份不正确。');
 await q.query('INSERT INTO template_versions(template_id,version,definition,owner_user_id) VALUES($1,$2,$3,NULL)',[definition.id,nextVersion,JSON.stringify(definition)]);
 await q.query('INSERT INTO community_publications(listing_id,template_id,template_version,submission_id) VALUES($1,$2,$3,$4)',[listing.id,definition.id,nextVersion,submission.id]);
 await q.query("UPDATE community_listings SET status='listed',title=$2,description=$3,category=$4,author_name=$5,recommended_version=$6,moderation_reason=NULL,version=version+1,updated_at=now(),published_at=now() WHERE id=$1",[listing.id,payload.title,payload.description,payload.category,payload.authorName,nextVersion]);
 await q.query("UPDATE community_submissions SET status='published',published_version=$2,version=version+1,updated_at=now() WHERE id=$1",[submission.id,nextVersion]);
 const [next]=await q.query<SubmissionRow>('SELECT * FROM community_submissions WHERE id=$1',[submission.id]);return {submission:submissionView(next!),listing:await listingView(q,await lockedListing(q,listing.id))};
}
export async function changeCommunityVisibility(q:Transaction,userId:string,input:Extract<CommunityRequest,{action:'unlist'|'suspend'|'restore'}>,reviewers:ReadonlySet<string>){
 if(input.action!=='unlist')requireCommunityReviewer(userId,reviewers);
 const listing=await lockedListing(q,input.listingId);if(!listing.owner_user_id)return fail('not_found','这个作品已经撤下。');version(listing.version,input.expectedVersion);
 if(input.action==='unlist'){author(listing,userId);if(listing.status==='suspended')return fail('forbidden','审核暂停状态不能由作者解除。');if(listing.status!=='listed')return fail('invalid_input','这个作品当前没有上架。');}
 if(input.action==='restore'&&listing.status!=='suspended')return fail('invalid_input','这个作品没有被审核暂停。');
 const status=input.action==='suspend'?'suspended':'unlisted';await q.query('UPDATE community_listings SET status=$2,moderation_reason=$3,version=version+1,updated_at=now() WHERE id=$1',[listing.id,status,input.action==='suspend'?input.reason:null]);
 return {listing:await listingView(q,await lockedListing(q,listing.id))};
}
export async function reportCommunityListing(q:Transaction,userId:string,input:Extract<CommunityRequest,{action:'report'}>){
 const listing=await lockedListing(q,input.listingId);if(!listing.owner_user_id||listing.status==='author_deleted')return fail('not_found','这个作品已撤下。');
 const [published]=await q.query('SELECT template_version FROM community_publications WHERE listing_id=$1 AND template_version=$2',[listing.id,input.templateVersion]);if(!published)return fail('not_found','没有找到这个已发布版本。');
 const [existing]=await q.query<ReportRow>("SELECT * FROM community_reports WHERE reporter_user_id=$1 AND listing_id=$2 AND status='open'",[userId,listing.id]);if(existing)return {report:reportView(existing)};
 const [row]=await q.query<ReportRow>('INSERT INTO community_reports(reporter_user_id,listing_id,template_version,reason,details) VALUES($1,$2,$3,$4,$5) RETURNING *',[userId,listing.id,input.templateVersion,input.reason,input.details]);return {report:reportView(row!)};
}
export async function resolveCommunityReport(q:Transaction,userId:string,input:Extract<CommunityRequest,{action:'resolve_report'}>,reviewers:ReadonlySet<string>){
 requireCommunityReviewer(userId,reviewers);const [identity]=await q.query<{listing_id:string}>('SELECT listing_id FROM community_reports WHERE id=$1',[input.reportId]);if(!identity)return fail('not_found','没有找到这条举报。');
 const listing=await lockedListing(q,identity.listing_id);const [report]=await q.query<ReportRow>('SELECT * FROM community_reports WHERE id=$1 FOR UPDATE',[input.reportId]);version(report!.version,input.expectedVersion);if(report!.status!=='open')return fail('version_conflict','这条举报已经处理。');
 if(listing.owner_user_id===userId||report!.reporter_user_id===userId)return fail('forbidden','请由另一位审核者处理涉及自己的举报。');
 if(input.resolution==='actioned'){version(listing.version,input.expectedListingVersion!);if(listing.status==='author_deleted')return fail('invalid_input','作者已经离开，作品已撤下。');await q.query("UPDATE community_listings SET status='suspended',moderation_reason=$2,version=version+1,updated_at=now() WHERE id=$1",[listing.id,input.reason]);}
 await q.query('UPDATE community_reports SET status=$2,resolution_reason=$3,reviewer_user_id=$4,version=version+1,updated_at=now() WHERE id=$1',[report!.id,input.resolution,input.reason,userId]);const [next]=await q.query<ReportRow>('SELECT * FROM community_reports WHERE id=$1',[report!.id]);return {report:reportView(next!)};
}
export async function getCommunitySubmission(q:Queryable,userId:string,id:string,reviewers:ReadonlySet<string>=new Set()){await requireActiveUser(q,userId);const [r]=await q.query<SubmissionRow>('SELECT * FROM community_submissions WHERE id=$1',[id]);if(!r||r.owner_user_id!==userId&&!reviewers.has(userId))return fail('not_found','没有找到这次申请。');return submissionView(r);}
export async function listCommunityReviewQueue(q:Queryable,userId:string,reviewers:ReadonlySet<string>,options:CommunityPaging&{status?:CommunitySubmission['status']}={}){await requireActiveUser(q,userId);requireCommunityReviewer(userId,reviewers);const {limit,offset}=pagination(options),status=options.status??'pending';const [count]=await q.query<{n:number}>('SELECT count(*)::int AS n FROM community_submissions s JOIN users u ON u.id=s.owner_user_id WHERE u.deleted_at IS NULL AND s.status=$1',[status]);const rows=await q.query<SubmissionRow>('SELECT s.* FROM community_submissions s JOIN users u ON u.id=s.owner_user_id WHERE u.deleted_at IS NULL AND s.status=$1 ORDER BY s.created_at,s.id LIMIT $2 OFFSET $3',[status,limit,offset]);return {submissions:rows.map(submissionView),total:count!.n};}
export async function listCommunityReports(q:Queryable,userId:string,reviewers:ReadonlySet<string>,options:CommunityPaging&{status?:CommunityReport['status']}={}){await requireActiveUser(q,userId);requireCommunityReviewer(userId,reviewers);const {limit,offset}=pagination(options),status=options.status??'open';const [count]=await q.query<{n:number}>('SELECT count(*)::int AS n FROM community_reports WHERE status=$1',[status]);const rows=await q.query<ReportRow>('SELECT * FROM community_reports WHERE status=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3',[status,limit,offset]);return {reports:rows.map(reportView),total:count!.n};}
export async function exportCommunityData(q:Queryable,userId:string){const works=await listAuthorCommunity(q,userId,{limit:100,offset:0});const submissions=await q.query<SubmissionRow>('SELECT * FROM community_submissions WHERE owner_user_id=$1 ORDER BY created_at,id',[userId]);const reports=await q.query<ReportRow>('SELECT * FROM community_reports WHERE reporter_user_id=$1 ORDER BY created_at,id',[userId]);const adoptions=await q.query('SELECT a.listing_id,a.template_version,a.plan_id,a.created_at FROM community_adoptions a JOIN plans p ON p.id=a.plan_id WHERE p.user_id=$1 ORDER BY a.created_at,a.id',[userId]);return {works:works.listings,submissions:submissions.map(submissionView),reports:reports.map(reportView),adoptions};}

export async function getPublicationEligibility(q:Queryable,userId:string,id:string,requestedVersion?:number){
 await requireActiveUser(q,userId);
 const [row]=await q.query<{publish_eligible:boolean;source_plan_id:string|null;source_template_id:string|null}>('SELECT d.publish_eligible,d.source_plan_id,d.source_template_id FROM creation_drafts d JOIN template_versions v ON v.template_id=d.template_id AND v.owner_user_id=d.user_id WHERE d.user_id=$1 AND d.template_id=$2 AND ($3::integer IS NULL OR v.version=$3) ORDER BY v.version DESC LIMIT 1',[userId,id,requestedVersion??null]);
 if(!row)return fail('not_found','没有找到这个私人模板。');
 const canPublish=row.publish_eligible&&!row.source_plan_id&&!row.source_template_id;
 return {canPublish,reason:canPublish?null:'私人改编作品或无法确认原创来源的旧草稿本期仅供自己使用。'};
}
export async function getReviewCommunityListing(q:Queryable,userId:string,id:string,reviewers:ReadonlySet<string>){await requireActiveUser(q,userId);requireCommunityReviewer(userId,reviewers);const [row]=await q.query<ListingRow>('SELECT * FROM community_listings WHERE id=$1',[id]);if(!row)return fail('not_found','没有找到这个作品。');return listingView(q,row);}

/** Only persisted submission/review/publication/receipt evidence is history. */
export async function getCommunityHistory(q:Queryable,userId:string,id:string,reviewers:ReadonlySet<string>=new Set(),options:CommunityPaging={}):Promise<CommunityHistory>{
 await requireActiveUser(q,userId);const key=listingId(id),{limit,offset}=pagination(options);
 const [listing]=await q.query<ListingRow>('SELECT * FROM community_listings WHERE id=$1',[key]);
 if(!listing||listing.owner_user_id!==userId&&!reviewers.has(userId))return fail('not_found','没有找到这个作品。');
 const [count]=await q.query<{n:number}>('SELECT count(*)::int AS n FROM community_submissions WHERE listing_id=$1',[key]);
 const submissions=await q.query<SubmissionRow>('SELECT * FROM community_submissions WHERE listing_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',[key,limit,offset]);
 const history=`WITH events AS (
  SELECT 'submission:'||s.id::text AS id,'submitted' AS kind,s.created_at AS at,'pending' AS status,s.id::text AS submission_id,
   (s.public_payload#>>'{definition,version}')::int AS template_version,NULL::text AS reason FROM community_submissions s WHERE s.listing_id=$1
  UNION ALL SELECT 'review:'||r.id::text,r.decision,r.created_at,r.decision,s.id::text,(s.public_payload#>>'{definition,version}')::int,r.reason
   FROM community_reviews r JOIN community_submissions s ON s.id=r.submission_id WHERE s.listing_id=$1
  UNION ALL SELECT 'publication:'||p.template_version::text,'published',p.published_at,'listed',p.submission_id::text,p.template_version,NULL
   FROM community_publications p WHERE p.listing_id=$1
  UNION ALL SELECT 'withdrawal:'||s.id::text,'withdrawn',s.updated_at,'withdrawn',s.id::text,(s.public_payload#>>'{definition,version}')::int,NULL
   FROM community_submissions s WHERE s.listing_id=$1 AND s.status='withdrawn'
  UNION ALL SELECT 'visibility:'||r.client_op_id::text,
   CASE r.response->>'kind' WHEN 'unlist' THEN 'unlisted' WHEN 'suspend' THEN 'suspended' WHEN 'restore' THEN 'restored' ELSE 'published' END,
   r.created_at,r.response#>>'{listing,status}',r.response#>>'{submission,id}',(r.response#>>'{listing,templateVersion}')::int,r.response#>>'{listing,moderationReason}'
   FROM community_requests r WHERE r.response#>>'{listing,id}'=$1::uuid::text AND (
    r.response->>'kind' IN('unlist','suspend','restore') OR (r.response->>'kind'='publish' AND NOT EXISTS(
     SELECT 1 FROM community_publications p WHERE p.listing_id=$1 AND p.submission_id::text=r.response#>>'{submission,id}' AND p.published_at=r.created_at)))
  UNION ALL SELECT 'moderation:'||r.id::text,'suspended',r.updated_at,'suspended',NULL,NULL,r.resolution_reason
   FROM community_reports r WHERE r.listing_id=$1 AND r.status='actioned'
 )`;
 const [eventsCount]=await q.query<{n:number}>(`${history} SELECT count(*)::int AS n FROM events`,[key]);
 const rows=await q.query<{id:string;kind:CommunityHistoryEvent['kind'];at:Date;status:string;submission_id:string|null;template_version:number|null;reason:string|null}>(`${history} SELECT * FROM events ORDER BY at DESC,id DESC LIMIT $2 OFFSET $3`,[key,limit,offset]);
 return {listingId:key,submissions:submissions.map(submissionView),totalSubmissions:count!.n,
  events:rows.map(r=>({id:r.id,kind:r.kind,at:iso(r.at),status:r.status,submissionId:r.submission_id,templateVersion:r.template_version,reason:r.reason})),totalEvents:eventsCount!.n};
}
