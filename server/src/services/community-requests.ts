import type { Db } from '../db/db.js';
import { shanghaiDate } from '../domain/time.js';
import { requireActiveUser } from './deletion.js';
import { fail } from './errors.js';
import { communityHash,createCommunityPreview,submitCommunityPreview,withdrawCommunitySubmission,reviewCommunitySubmission,publishCommunitySubmission,changeCommunityVisibility,reportCommunityListing,resolveCommunityReport,communityRequestBody,type CommunityRequest,type CommunityResult } from './community.js';
export { communityRequestBody,type CommunityRequest,type CommunityResult } from './community.js';
export interface CommunityOptions {reviewerUserIds:ReadonlySet<string>;now?:()=>Date}
/** All community writes finish with their receipt in one account transaction. */
export class CommunityRequests {
 constructor(private readonly db:Db,private readonly options:CommunityOptions){}
 async lookup(userId:string,id:string):Promise<{status:'succeeded';result:CommunityResult}|{status:'not_found'}>{return this.db.tx(async q=>{await requireActiveUser(q,userId);const [row]=await q.query<{response:CommunityResult}>('SELECT response FROM community_requests WHERE user_id=$1 AND client_op_id=$2',[userId,id]);return row?{status:'succeeded' as const,result:row.response}:{status:'not_found' as const};},userId);}
 async submit(userId:string,raw:CommunityRequest):Promise<CommunityResult>{const input=communityRequestBody.parse(raw),hash=communityHash(input);return this.db.tx(async q=>{
  await requireActiveUser(q,userId);const [prior]=await q.query<{request_hash:string;response:CommunityResult}>('SELECT request_hash,response FROM community_requests WHERE user_id=$1 AND client_op_id=$2 FOR UPDATE',[userId,input.clientOpId]);
  if(prior){if(prior.request_hash!==hash)return fail('operation_changed','同一请求标识的内容发生了变化，请先核对原结果。');return prior.response;}
  const now=this.options.now?.()??new Date();
  const output=input.action==='preview'?await createCommunityPreview(q,userId,input,shanghaiDate(now),now)
   :input.action==='submit'?await submitCommunityPreview(q,userId,input,now)
   :input.action==='withdraw'?await withdrawCommunitySubmission(q,userId,input)
   :input.action==='review'?await reviewCommunitySubmission(q,userId,input,this.options.reviewerUserIds)
   :input.action==='publish'?await publishCommunitySubmission(q,userId,input)
   :input.action==='report'?await reportCommunityListing(q,userId,input)
   :input.action==='resolve_report'?await resolveCommunityReport(q,userId,input,this.options.reviewerUserIds)
   :await changeCommunityVisibility(q,userId,input,this.options.reviewerUserIds);
  const result:CommunityResult={clientOpId:input.clientOpId,kind:input.action,transient:false,...output};
  let subject=userId;
  if(result.listing){const [row]=await q.query<{owner_user_id:string|null}>('SELECT owner_user_id FROM community_listings WHERE id=$1',[result.listing.id]);subject=row?.owner_user_id??userId;}
  else if(result.report){const [row]=await q.query<{reporter_user_id:string}>('SELECT reporter_user_id FROM community_reports WHERE id=$1',[result.report.id]);subject=row?.reporter_user_id??userId;}
  await q.query('INSERT INTO community_requests(user_id,subject_user_id,client_op_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[userId,subject,input.clientOpId,hash,JSON.stringify(result)]);return result;
 },userId);}
}
