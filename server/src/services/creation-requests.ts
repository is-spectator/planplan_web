import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, Queryable, Transaction } from '../db/db.js';
import { creationHistoryAfterCancel, isCreationCancel, type CreationLlm } from '../ai/creation.js';
import { LlmError } from '../ai/llm.js';
import { shanghaiDate } from '../domain/time.js';
import { requireActiveUser } from './deletion.js';
import { DomainError } from './errors.js';
import {
  createCreationDraft, getCreationDraft, updateCreationDraft, clarifyCreationDraft,
  undoCreationDraft, saveCreationDraft, deleteCreationDraft, type CreationDraft, type DeletedCreation,
} from './creation-drafts.js';

const identity = { clientOpId: z.uuid() };
const versioned = { ...identity, draftId: z.uuid(), expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) };
export const creationRequestBody = z.discriminatedUnion('action', [
  z.object({ ...identity, action: z.literal('create') }).strict(),
  z.object({ ...identity, action: z.literal('fork'), sourceTemplateId: z.string().min(1).max(120).optional(), sourceTemplateVersion: z.number().int().positive().optional(), sourcePlanId: z.uuid().optional() }).strict().refine(body =>
    body.sourcePlanId ? body.sourceTemplateId === undefined && body.sourceTemplateVersion === undefined : !!body.sourceTemplateId && body.sourceTemplateVersion !== undefined,
  ),
  z.object({ ...versioned, action: z.literal('message'), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ ...versioned, action: z.literal('update'), definition: z.unknown() }).strict(),
  z.object({ ...versioned, action: z.literal('undo') }).strict(),
  z.object({ ...versioned, action: z.literal('save') }).strict(),
  z.object({ ...versioned, action: z.literal('delete'), confirmDelete: z.literal(true) }).strict(),
]);
export type CreationRequest = z.infer<typeof creationRequestBody>;
export interface CreationDraftResult { clientOpId: string; kind: Exclude<CreationRequest['action'],'delete'>; draft: CreationDraft; transient: boolean; message?: string }
export interface CreationDeleteResult { clientOpId:string; kind:'delete'; transient:false; deleted:DeletedCreation }
export type CreationResult=CreationDraftResult|CreationDeleteResult;
export interface CreationProcessing { status: 'processing' }
type StoredError = { code: DomainError['code']; message: string; details: Record<string, unknown> };
type RequestRow = {
  request_hash: string; status: 'processing' | 'succeeded' | 'retryable' | 'failed';
  response: CreationResult | null; error: StoredError | null; lease_token: string | null; lease_until: Date | string | null;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(request: CreationRequest) { return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex'); }
function storedError(error: DomainError): StoredError { return { code: error.code, message: error.message, details: error.details }; }
function rethrow(error: StoredError): never { throw new DomainError(error.code, error.message, error.details); }

/** The durable lease fences late model responses. No DB transaction spans an AI call. */
export class CreationRequests {
  constructor(private readonly db: Db, private readonly llm: CreationLlm | undefined, private readonly consentVersion: string | null,
    private readonly now: () => Date = () => new Date(), private readonly leaseMs = 120_000) {}

  private async consent(q: Queryable, userId: string, tokenVersion?: number): Promise<number> {
    await requireActiveUser(q, userId);
    const [user] = await q.query<{ ai_consent: boolean; ai_consent_version: string | null; token_version: number }>('SELECT ai_consent,ai_consent_version,token_version FROM users WHERE id=$1', [userId]);
    if (!user || tokenVersion !== undefined && user.token_version !== tokenVersion) throw new DomainError('unauthorized', '会话已结束，请重新登录后继续。');
    if (!user.ai_consent || this.consentVersion && user.ai_consent_version !== this.consentVersion) throw new DomainError('ai_consent_required', '请先阅读并同意云端 AI 服务说明，也可以手动编辑模板。');
    return user.token_version;
  }

  private async row(q: Queryable, userId: string, id: string): Promise<RequestRow | undefined> {
    return (await q.query<RequestRow>('SELECT request_hash,status,response,error,lease_token,lease_until FROM creation_requests WHERE user_id=$1 AND client_op_id=$2 FOR UPDATE', [userId, id]))[0];
  }

  private async notDeleted(q:Queryable,userId:string,id:string,hash?:string):Promise<void> {
    const [deleted]=await q.query<{request_hash:string}>('SELECT request_hash FROM creation_deleted_requests WHERE user_id=$1 AND client_op_id=$2',[userId,id]);
    if(deleted){if(hash!==undefined&&hash!==deleted.request_hash)throw new DomainError('operation_changed','这次请求的内容发生了变化，请使用新的请求标识。');throw new DomainError('not_found','这份私人创作已删除，已有计划仍可继续使用。');}
  }

  async lookup(userId: string, id: string): Promise<{ status: 'succeeded'; result: CreationResult } | { status: 'processing' | 'not_found' }> {
    return this.db.tx(async q => {
      await requireActiveUser(q, userId);
      const row = await this.row(q, userId, id);
      if (row?.status === 'succeeded' && row.response) return { status: 'succeeded', result: row.response };
      return { status: row?.status === 'processing' && row.lease_until && new Date(row.lease_until).getTime() > this.now().getTime() ? 'processing' : 'not_found' };
    }, userId);
  }

  private async finish(q: Transaction, userId: string, request: Exclude<CreationRequest,{action:'delete'}>, token: string, draft: CreationDraft): Promise<CreationDraftResult> {
    const result: CreationDraftResult = { clientOpId: request.clientOpId, kind: request.action, draft, transient: false };
    await this.finishResult(q,userId,request.clientOpId,token,result);
    return result;
  }

  private async finishResult(q:Transaction,userId:string,id:string,token:string,result:CreationResult):Promise<void> {
    const saved = await q.query(`UPDATE creation_requests SET status='succeeded',response=$4,error=NULL,lease_token=NULL,lease_until=NULL,updated_at=$5
      WHERE user_id=$1 AND client_op_id=$2 AND status='processing' AND lease_token=$3 RETURNING client_op_id`, [userId, id, token, JSON.stringify(result), this.now()]);
    if (!saved.length) throw new DomainError('version_conflict', '这次创作请求已由其他会话处理，请核对最新草稿。');
  }

  async submit(userId: string, request: CreationRequest): Promise<CreationResult | CreationProcessing> {
    const requestHash = digest(request);
    const admission = await this.db.tx(async q => {
      await requireActiveUser(q, userId);
      await this.notDeleted(q,userId,request.clientOpId,requestHash);
      const row = await this.row(q, userId, request.clientOpId);
      if (row && row.request_hash !== requestHash) throw new DomainError('operation_changed', '这次请求的内容发生了变化，请先核对原请求。');
      if (row?.status === 'succeeded' && row.response) return { result: row.response };
      if (row?.status === 'failed' && row.error) rethrow(row.error);
      if (row?.status === 'processing' && row.lease_until && new Date(row.lease_until).getTime() > this.now().getTime()) return { processing: true as const };
      let draft: CreationDraft | undefined;
      let tokenVersion: number | undefined;
      if (request.action === 'message') {
        draft = await getCreationDraft(q, userId, request.draftId);
        if (draft.version !== request.expectedVersion) throw new DomainError('version_conflict', '草稿已更新，请核对最新内容后再发送。');
        if (draft.messages.length >= 100) throw new DomainError('invalid_input', '这份草稿的对话已达到上限，请保存当前模板，再新建草稿继续设计。');
        if (!isCreationCancel(request.text)) tokenVersion = await this.consent(q, userId);
      }
      const token = randomUUID(), at = this.now(), until = new Date(at.getTime() + this.leaseMs);
      await q.query(`INSERT INTO creation_requests(user_id,client_op_id,request_hash,status,request,lease_token,lease_until,created_at,updated_at)
        VALUES($1,$2,$3,'processing',$4,$5,$6,$7,$7) ON CONFLICT(user_id,client_op_id) DO UPDATE SET status='processing',response=NULL,error=NULL,lease_token=$5,lease_until=$6,updated_at=$7`,
      [userId, request.clientOpId, requestHash, JSON.stringify(request), token, until, at]);
      if(request.action==='delete'){
        const deleted=await deleteCreationDraft(q,userId,request.draftId,request.expectedVersion,request.clientOpId);
        const result:CreationDeleteResult={clientOpId:request.clientOpId,kind:'delete',transient:false,deleted};
        await this.finishResult(q,userId,request.clientOpId,token,result);
        return {result};
      }
      if (request.action === 'message') {
        if (isCreationCancel(request.text)) {
          const cancelled = await clarifyCreationDraft(q, userId, request.draftId, request.expectedVersion, request.text, '已取消这次调整，当前草稿保留。接下来请直接说新的想法。');
          return { result: await this.finish(q, userId, request, token, cancelled) };
        }
        return { token, draft: draft!, tokenVersion: tokenVersion! };
      }
      const next = request.action === 'create' ? await createCreationDraft(q, userId)
        : request.action === 'fork' ? await createCreationDraft(q, userId, request)
        : request.action === 'update' ? await updateCreationDraft(q, userId, request.draftId, request.expectedVersion, request.definition)
        : request.action === 'undo' ? await undoCreationDraft(q, userId, request.draftId, request.expectedVersion)
        : await saveCreationDraft(q, userId, request.draftId, request.expectedVersion);
      return { result: await this.finish(q, userId, request, token, next) };
    }, userId);
    if ('result' in admission && admission.result) return admission.result;
    if ('processing' in admission) return { status: 'processing' };
    if (request.action !== 'message' || !('token' in admission) || !admission.token) throw new Error('Invalid creation admission');
    const { token, draft, tokenVersion } = admission;
    try {
      if (!this.llm) throw new LlmError('unavailable');
      const generated = await this.llm.generate({ userId, requestId: `creation:${request.clientOpId}`, today: shanghaiDate(this.now()), instruction: request.text,
        currentDefinition: draft.definition, history: creationHistoryAfterCancel(draft.messages.map(message => ({ role: message.role, text: message.text }))).slice(-12) });
      return await this.db.tx(async q => {
        await this.consent(q, userId, tokenVersion);
        await this.notDeleted(q,userId,request.clientOpId);
        const held = await this.row(q, userId, request.clientOpId);
        if (held?.status === 'succeeded' && held.response) return held.response;
        if (!held || held.status !== 'processing' || held.lease_token !== token || !held.lease_until || new Date(held.lease_until).getTime() <= this.now().getTime()) return { status: 'processing' as const };
        const next = generated.kind === 'proposal'
          ? await updateCreationDraft(q, userId, request.draftId, request.expectedVersion, generated.definition, { userText: request.text, assistantText: generated.reply })
          : await clarifyCreationDraft(q, userId, request.draftId, request.expectedVersion, request.text, generated.reply);
        return this.finish(q, userId, request, token, next);
      }, userId);
    } catch (error) {
      // A rejected/invalid model proposal never overwrites the previous draft.
      const retryable = error instanceof LlmError || error instanceof DomainError && error.code === 'invalid_input';
      if (!retryable && !(error instanceof DomainError)) throw error;
      const outcome = await this.db.tx(async q => {
        await requireActiveUser(q, userId);
        await this.notDeleted(q,userId,request.clientOpId);
        const held = await this.row(q, userId, request.clientOpId);
        if (held?.status === 'succeeded' && held.response) return held.response;
        if (!held || held.status !== 'processing' || held.lease_token !== token) return { status: 'processing' as const };
        if (!retryable) {
          await q.query("UPDATE creation_requests SET status='failed',error=$4,lease_token=NULL,lease_until=NULL,updated_at=$5 WHERE user_id=$1 AND client_op_id=$2 AND lease_token=$3", [userId, request.clientOpId, token, JSON.stringify(storedError(error as DomainError)), this.now()]);
          return null;
        }
        const current = await getCreationDraft(q, userId, request.draftId);
        const message = error instanceof LlmError && error.kind === 'timeout'
          ? '这次生成等待超时，原草稿已保留。可以重试或手动编辑。'
          : error instanceof LlmError && !['invalid_output', 'invalid_request'].includes(error.kind)
            ? '暂时无法完成创作，原草稿已保留。可以稍后重试或手动编辑。'
            : '生成的模板暂时无法使用，原草稿已保留。可以重试或手动编辑。';
        const result: CreationResult = { clientOpId: request.clientOpId, kind: 'message', draft: current, transient: true, message };
        await q.query("UPDATE creation_requests SET status='retryable',response=$4,error=NULL,lease_token=NULL,lease_until=NULL,updated_at=$5 WHERE user_id=$1 AND client_op_id=$2 AND lease_token=$3", [userId, request.clientOpId, token, JSON.stringify(result), this.now()]);
        return result;
      }, userId);
      if (outcome) return outcome;
      throw error;
    }
  }
}
