import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Db,Queryable } from '../db/db.js';
import { requireActiveUser } from './deletion.js';
import { fail } from './errors.js';
const statuses=z.enum(['open','in_progress','resolved']);
const knownRoutes=new Set(['/','/chat','/plans','/plans/:id','/market','/market/:id','/create','/create/:id','/create/templates/:id','/me','/my','/settings','/feedback','/feedback/:id','/moderation','/moderation/submissions','/moderation/reports','/moderation/feedback']);
function diagnosticRoute(route:string){
 if(knownRoutes.has(route))return route;
 if(/^\/(plans|create|feedback)\/[a-f0-9-]{36}$/i.test(route))return route.replace(/\/[^/]+$/,'/:id');
 if(/^\/(market|create\/templates)\/(?:official\.[a-z]+|(?:private|community)\.[a-f0-9-]{36})$/i.test(route))return route.replace(/\/[^/]+$/,'/:id');
 return null;
}
export const feedbackDiagnosticsSchema=z.strictObject({route:z.string().max(160).refine(v=>diagnosticRoute(v)!==null,'只允许已知页面路径，不含查询参数。').transform(v=>diagnosticRoute(v)!),version:z.string().max(80).regex(/^(?:local|[a-f0-9]{7,40}|v?\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]{1,40})?)$/)});
export const feedbackRequestBody=z.discriminatedUnion('action',[
 z.strictObject({clientOpId:z.uuid(),action:z.literal('create'),description:z.string().trim().min(1).max(2000),diagnostics:feedbackDiagnosticsSchema.optional()}),
 z.strictObject({clientOpId:z.uuid(),action:z.literal('update'),ticketId:z.uuid(),expectedVersion:z.number().int().positive(),status:statuses,response:z.string().trim().max(2000)}).refine(v=>v.status!=='resolved'||!!v.response,'解决反馈时请填写处理说明。'),
]);
export type FeedbackRequest=z.infer<typeof feedbackRequestBody>;
export interface FeedbackTicket {id:string;version:number;status:z.infer<typeof statuses>;description:string;diagnostics:z.infer<typeof feedbackDiagnosticsSchema>|null;response:string|null;history:{status:z.infer<typeof statuses>;response:string;createdAt:string}[];createdAt:string;updatedAt:string}
export interface FeedbackResult {clientOpId:string;kind:FeedbackRequest['action'];transient:false;ticket:FeedbackTicket}
type Row={id:string;user_id:string;version:number;status:FeedbackTicket['status'];description:string;diagnostics:FeedbackTicket['diagnostics'];response:string|null;created_at:Date;updated_at:Date};
const iso=(v:Date|string)=>new Date(v).toISOString();
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>[k,canonical(value)])):v;
const paging=(input:{limit?:number;offset?:number}={})=>{const limit=input.limit??20,offset=input.offset??0;if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>10000)fail('invalid_input','分页范围不正确。');return {limit,offset};};
const reviewer=(userId:string,ids:ReadonlySet<string>)=>{if(!ids.has(userId))fail('forbidden','当前账户没有反馈处理权限。');};
async function view(q:Queryable,row:Row):Promise<FeedbackTicket>{const history=await q.query<{status:FeedbackTicket['status'];response:string;created_at:Date}>('SELECT status,response,created_at FROM feedback_updates WHERE ticket_id=$1 ORDER BY created_at,id',[row.id]);return {id:row.id,version:row.version,status:row.status,description:row.description,diagnostics:row.diagnostics,response:row.response,history:history.map(r=>({status:r.status,response:r.response,createdAt:iso(r.created_at)})),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
export async function getFeedbackTicket(q:Queryable,userId:string,id:string,reviewerIds:ReadonlySet<string>=new Set()):Promise<FeedbackTicket>{await requireActiveUser(q,userId);const [row]=await q.query<Row>('SELECT t.* FROM feedback_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND u.deleted_at IS NULL',[id]);if(!row||row.user_id!==userId&&!reviewerIds.has(userId))return fail('not_found','没有找到这条反馈。');return view(q,row);}
export async function listOwnFeedback(q:Queryable,userId:string,options:{limit?:number;offset?:number}={}){await requireActiveUser(q,userId);const {limit,offset}=paging(options);const [count]=await q.query<{n:number}>('SELECT count(*)::int AS n FROM feedback_tickets WHERE user_id=$1',[userId]);const rows=await q.query<Row>('SELECT * FROM feedback_tickets WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',[userId,limit,offset]);return {tickets:await Promise.all(rows.map(r=>view(q,r))),total:count!.n};}
export async function listFeedbackQueue(q:Queryable,userId:string,reviewerIds:ReadonlySet<string>,options:{status?:FeedbackTicket['status'];limit?:number;offset?:number}={}){await requireActiveUser(q,userId);reviewer(userId,reviewerIds);const {limit,offset}=paging(options),status=options.status??'open';const [count]=await q.query<{n:number}>('SELECT count(*)::int AS n FROM feedback_tickets t JOIN users u ON u.id=t.user_id WHERE u.deleted_at IS NULL AND t.status=$1',[status]);const rows=await q.query<Row>('SELECT t.* FROM feedback_tickets t JOIN users u ON u.id=t.user_id WHERE u.deleted_at IS NULL AND t.status=$1 ORDER BY t.updated_at,t.id LIMIT $2 OFFSET $3',[status,limit,offset]);return {tickets:await Promise.all(rows.map(r=>view(q,r))),total:count!.n};}
export async function exportFeedbackData(q:Queryable,userId:string){await requireActiveUser(q,userId);const rows=await q.query<Row>('SELECT * FROM feedback_tickets WHERE user_id=$1 ORDER BY created_at,id',[userId]);return {tickets:await Promise.all(rows.map(row=>view(q,row)))};}
export class FeedbackRequests {
 constructor(private readonly db:Db,private readonly options:{reviewerUserIds:ReadonlySet<string>}){}
 async lookup(userId:string,id:string):Promise<{status:'succeeded';result:FeedbackResult}|{status:'not_found'}>{return this.db.tx(async q=>{await requireActiveUser(q,userId);const [row]=await q.query<{response:FeedbackResult}>('SELECT response FROM feedback_requests WHERE user_id=$1 AND client_op_id=$2',[userId,id]);return row?{status:'succeeded' as const,result:row.response}:{status:'not_found' as const};},userId);}
 async submit(userId:string,raw:FeedbackRequest):Promise<FeedbackResult>{const input=feedbackRequestBody.parse(raw),hash=createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');return this.db.tx(async q=>{
  await requireActiveUser(q,userId);const [existing]=await q.query<{request_hash:string;response:FeedbackResult}>('SELECT request_hash,response FROM feedback_requests WHERE user_id=$1 AND client_op_id=$2 FOR UPDATE',[userId,input.clientOpId]);if(existing){if(existing.request_hash!==hash)return fail('operation_changed','同一请求标识的内容已变化，请先核对原结果。');return existing.response;}
  let row:Row;
  if(input.action==='create'){const [created]=await q.query<Row>('INSERT INTO feedback_tickets(user_id,description,diagnostics) VALUES($1,$2,$3) RETURNING *',[userId,input.description,input.diagnostics?JSON.stringify(input.diagnostics):null]);row=created!;}
  else {reviewer(userId,this.options.reviewerUserIds);const [current]=await q.query<Row>('SELECT t.* FROM feedback_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND u.deleted_at IS NULL FOR UPDATE OF t',[input.ticketId]);if(!current)return fail('not_found','没有找到这条反馈。');if(current.version!==input.expectedVersion)return fail('version_conflict','反馈已被处理，请核对最新状态。');const [updated]=await q.query<Row>('UPDATE feedback_tickets SET status=$2,response=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[current.id,input.status,input.response||null]);row=updated!;await q.query('INSERT INTO feedback_updates(ticket_id,reviewer_user_id,status,response) VALUES($1,$2,$3,$4)',[row.id,userId,input.status,input.response]);}
  const result:FeedbackResult={clientOpId:input.clientOpId,kind:input.action,transient:false,ticket:await view(q,row)};
  await q.query('INSERT INTO feedback_requests(user_id,client_op_id,ticket_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[userId,input.clientOpId,row.id,hash,JSON.stringify(result)]);return result;
 },userId);}
}
