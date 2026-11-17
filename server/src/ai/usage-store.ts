import type { Db, Queryable } from '../db/db.js';
import { createHash } from 'node:crypto';
import { shanghaiDate } from '../domain/time.js';
import { requireActiveUser } from '../services/deletion.js';
import type { LlmContext, LlmErrorKind, LlmResult } from './llm.js';
import type { AttemptCost } from './cost.js';
import { BUILD_FINGERPRINT } from './runtime-config.js';

type Monthly = { month: string; attempts: string; pending_attempts: string; unknown_cost_attempts: string; known_cost_pico: string };
export interface AttemptStart extends LlmContext { attemptId: string; model: string; role: 'primary' | 'fallback'; mode: 'compact' | 'strict'; at: Date; priceVersion: string | null; promptVersion?: string; protocolVersion?: string }
export interface AttemptFinish { attemptId: string; latencyMs: number; error: LlmErrorKind | null; usage: LlmResult['usage']; cost: AttemptCost }

/** clientMsgId 可由外部任意填写，计费明细只保存摘要；J2可按用户+operation.client_op_id确定性关联。 */
export function attemptRequestDigest(userId: string, requestId: string): string {
  return createHash('sha256').update(JSON.stringify([userId, requestId])).digest('hex');
}

async function alert(q: Queryable, month: string, kind: string, props: Record<string, unknown>) {
  const inserted = await q.query(`INSERT INTO ai_cost_alerts (month, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING month`, [month, kind]);
  if (inserted.length) await q.query(`INSERT INTO events (name, props) VALUES ($1, $2)`, [kind === 'budget_exceeded' ? 'model_budget_exceeded' : 'model_cost_unknown', JSON.stringify({ month, ...props })]);
}

/** 每次真正调用前产生唯一 attemptId；clientMsgId 只用于个人追溯，绝非费用去重键。 */
export class UsageStore {
  constructor(private readonly db: Db, private readonly budgetPico: bigint) {}

  async start(a: AttemptStart): Promise<void> {
    const month = shanghaiDate(a.at).slice(0, 7);
    await this.db.tx(async (q) => {
      await requireActiveUser(q, a.userId);
      await q.query(`INSERT INTO ai_monthly_usage (month) VALUES ($1) ON CONFLICT DO NOTHING`, [month]);
      const inserted = await q.query(`INSERT INTO ai_usage_receipts (attempt_id, month, pending_since) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING attempt_id`, [a.attemptId, month, a.at]);
      if (!inserted.length) return;
      await q.query(`INSERT INTO ai_attempts (attempt_id,user_id,request_hash,role,model,output_mode,prompt_version,protocol_version,started_at,price_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [a.attemptId, a.userId, attemptRequestDigest(a.userId, a.requestId), a.role, a.model, a.mode, a.promptVersion ?? BUILD_FINGERPRINT.prompt, a.protocolVersion ?? BUILD_FINGERPRINT.protocol, a.at, a.priceVersion]);
      await q.query(`UPDATE ai_monthly_usage SET attempts=attempts+1, pending_attempts=pending_attempts+1, unknown_cost_attempts=unknown_cost_attempts+1 WHERE month=$1`, [month]);
    }, a.userId);
  }

  async finish(a: AttemptFinish): Promise<void> {
    await this.db.tx(async (q) => {
      const [receipt] = await q.query<{ month: string; finalized: boolean }>(`SELECT month, finalized FROM ai_usage_receipts WHERE attempt_id=$1 FOR UPDATE`, [a.attemptId]);
      if (!receipt) throw new Error('Attempt receipt is missing');
      if (receipt.finalized) return;
      const known = a.cost.pico !== null;
      await q.query(`UPDATE ai_usage_receipts SET finalized=true, pending_since=NULL, cost_status=$2, cost_pico=$3 WHERE attempt_id=$1`, [a.attemptId, a.cost.status, a.cost.pico?.toString() ?? null]);
      // 在途账户删除可能已清除个人行；匿名费用照样完成，绝不重建用户关联。
      await q.query(`UPDATE ai_attempts SET latency_ms=$2,outcome=$3,error_code=$4,prompt_tokens=$5,completion_tokens=$6,cached_prompt_tokens=$7,price_version=$8,cost_status=$9,cost_pico=$10 WHERE attempt_id=$1`,
        [a.attemptId, a.latencyMs, a.error ? 'failed' : 'succeeded', a.error, a.usage?.prompt ?? null, a.usage?.completion ?? null, a.usage?.cachedPrompt ?? null, a.cost.priceVersion, a.cost.status, a.cost.pico?.toString() ?? null]);
      const [month] = await q.query<Monthly>(`UPDATE ai_monthly_usage SET pending_attempts=pending_attempts-1,
        unknown_cost_attempts=unknown_cost_attempts-$2, known_cost_pico=known_cost_pico+$3 WHERE month=$1 RETURNING *`, [receipt.month, known ? 1 : 0, a.cost.pico?.toString() ?? '0']);
      const props = { knownCostPico: month!.known_cost_pico.toString(), unknownAttempts: month!.unknown_cost_attempts.toString(), budgetPico: this.budgetPico.toString(), policy: 'alert_only' };
      if (!known) await alert(q, receipt.month, `unknown:${a.cost.status}`, { ...props, reason: a.cost.status });
      if (BigInt(month!.known_cost_pico) >= this.budgetPico) await alert(q, receipt.month, 'budget_exceeded', props);
    }, `ai-attempt:${a.attemptId}`);
  }

  /** 进程中断后保留未完成调用为未知；发监控事件，不猜测零费用或重新调用模型。 */
  async alertStale(now: Date, staleAfterMs = 300_000): Promise<void> {
    await this.db.tx(async (q) => {
      const stale = await q.query<{ month: string }>(`UPDATE ai_usage_receipts SET stale_alerted=true WHERE NOT finalized AND NOT stale_alerted AND pending_since < $1 RETURNING month`, [new Date(now.getTime() - staleAfterMs)]);
      for (const month of new Set(stale.map((r) => r.month))) await alert(q, month, 'unknown:pending_attempt', { reason: 'pending_attempt', policy: 'alert_only' });
    }, 'ai-stale-attempts');
  }

  async pruneDetails(now: Date, retentionDays: number): Promise<void> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30) throw new Error('Attempt retention must be 1 to 30 days');
    await this.db.query(`DELETE FROM ai_attempts WHERE started_at < $1`, [new Date(now.getTime() - retentionDays * 86400_000)]);
  }
}
