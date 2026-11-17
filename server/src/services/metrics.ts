import type { Queryable } from '../db/db.js';

/** Aggregate output only. Rates use mature cohorts and return null without a denominator. */
export async function productMetrics(db: Queryable, asOf = new Date()) {
  if (!Number.isFinite(asOf.getTime())) throw new Error('Invalid report time');
  const [row] = await db.query<{ entered: number; activated: number; retained_eligible: number; retained: number; weekly_active: number; saved: number; corrected: number; unclassified: number }>(`
    WITH e AS (
      SELECT * FROM usage_events WHERE created_at >= $1::timestamptz - interval '30 days' AND created_at <= $1
    ), cohort AS (
      SELECT actor_id, first_seen_at AS entered_at FROM usage_entries
      WHERE NOT returning_user AND first_seen_at >= $1::timestamptz - interval '30 days' AND first_seen_at <= $1
    ), activation AS (
      SELECT c.*, EXISTS(SELECT 1 FROM e WHERE e.actor_id=c.actor_id AND e.name='plan_created' AND e.created_at>=c.entered_at AND e.created_at<c.entered_at+interval '24 hours')
        AND EXISTS(SELECT 1 FROM e WHERE e.actor_id=c.actor_id AND e.name='record_saved' AND e.created_at>=c.entered_at AND e.created_at<c.entered_at+interval '24 hours') AS activated
      FROM cohort c
    ), active_days AS (
      SELECT actor_id, count(DISTINCT (created_at AT TIME ZONE 'Asia/Shanghai')::date) AS days
      FROM e WHERE (name='record_saved' OR (name='query' AND props->>'valid'='true'))
        AND created_at >= (date_trunc('week', $1::timestamptz AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') GROUP BY actor_id
    ), saved_records AS (
      SELECT DISTINCT actor_id, props->>'recordId' AS record_id FROM e WHERE name='record_saved'
    ) SELECT
      (SELECT count(*)::int FROM activation WHERE entered_at <= $1::timestamptz - interval '24 hours') AS entered,
      (SELECT count(*)::int FROM activation WHERE entered_at <= $1::timestamptz - interval '24 hours' AND activated) AS activated,
      (SELECT count(*)::int FROM activation WHERE entered_at <= $1::timestamptz - interval '14 days' AND activated) AS retained_eligible,
      (SELECT count(*)::int FROM activation a WHERE a.entered_at <= $1::timestamptz - interval '14 days' AND a.activated AND EXISTS(
        SELECT 1 FROM e WHERE e.actor_id=a.actor_id AND e.created_at >= a.entered_at+interval '7 days' AND e.created_at<a.entered_at+interval '14 days'
          AND (e.name='record_saved' OR (e.name='query' AND e.props->>'valid'='true')))) AS retained,
      (SELECT count(*)::int FROM active_days WHERE days>=3) AS weekly_active,
      (SELECT count(*)::int FROM saved_records) AS saved,
      (SELECT count(*)::int FROM saved_records s WHERE EXISTS(SELECT 1 FROM e WHERE e.actor_id=s.actor_id AND e.name='correction' AND e.props->>'recordId'=s.record_id AND e.props->>'reason'='understanding_error')) AS corrected,
      (SELECT count(*)::int FROM e WHERE name='correction' AND props->>'reason'='unspecified') AS unclassified
  `, [asOf]);
  const r = row!;
  const [costs] = await db.query<{ matched: number; unmatched: number; known_pico: string; unknown_attempts: number }>(`
    WITH op AS (SELECT e.actor_id, a.user_id, e.props->>'operationId' AS operation_id,
        e.props->>'requestHash' AS request_hash, coalesce(e.props->>'rootHash',e.props->>'requestHash') AS root_hash
      FROM usage_events e JOIN usage_actors a ON a.actor_id=e.actor_id
      WHERE e.name='operation' AND e.props->>'source'='chat' AND e.created_at >= $1::timestamptz-interval '30 days' AND e.created_at <= $1),
    matched AS (SELECT op.actor_id, op.operation_id, count(a.attempt_id)::int AS attempts, coalesce(sum(a.cost_pico),0) AS known_pico,
      count(a.attempt_id) FILTER(WHERE a.cost_status <> 'known')::int AS unknowns FROM op LEFT JOIN ai_attempts a
      ON a.user_id=op.user_id AND a.started_at <= $1 AND (a.request_hash=op.request_hash OR a.request_hash=op.root_hash OR EXISTS(
        SELECT 1 FROM usage_request_links l WHERE l.actor_id=op.actor_id AND l.root_hash=op.root_hash AND l.request_hash=a.request_hash AND l.created_at <= $1))
      GROUP BY op.actor_id,op.operation_id)
    SELECT count(*) FILTER(WHERE attempts>0)::int AS matched, count(*) FILTER(WHERE attempts=0)::int AS unmatched, coalesce(sum(known_pico),0)::text AS known_pico, coalesce(sum(unknowns),0)::int AS unknown_attempts FROM matched
  `, [asOf]);
  const monthly = await db.query<{month:string;attempts:string;pending_attempts:string;unknown_cost_attempts:string;known_cost_pico:string}>(
    `SELECT month,attempts::text,pending_attempts::text,unknown_cost_attempts::text,known_cost_pico::text FROM ai_monthly_usage WHERE month=to_char($1::timestamptz AT TIME ZONE 'Asia/Shanghai','YYYY-MM')`, [asOf]);
  const interactions = await db.query<{ source:string; completed:number; average_inputs:number }>(`
    SELECT props->>'source' AS source, count(*)::int AS completed, avg(1+(props->>'clarificationRounds')::integer)::float AS average_inputs
    FROM usage_events WHERE name='request' AND props->>'status'='succeeded' AND (props->>'records')::integer>0
      AND created_at >= $1::timestamptz - interval '30 days' AND created_at <= $1 GROUP BY props->>'source'`, [asOf]);
  return {
    successfulRecordInteractions: interactions,
    modelCost: { associatedSuccessfulOperations: costs!.matched, unassociatedOperations: costs!.unmatched, knownCostPico: costs!.known_pico, unknownAttempts: costs!.unknown_attempts,
      averageObservedKnownCostPico: costs!.matched && !costs!.unknown_attempts ? (BigInt(costs!.known_pico) / BigInt(costs!.matched)).toString() : null,
      coverage: 'retained_associated_attempts_only', monthlySnapshotCapturedAt: new Date().toISOString(), monthlyTotalsAreCurrentSnapshot: true, currentMonth: monthly[0] ?? null },
    asOf: asOf.toISOString(), timezone: 'Asia/Shanghai', windowDays: 30,
    entryDefinition: 'first_server_observed_install_entry_excluding_linked_returning_accounts',
    activation24h: { eligible: r.entered, activated: r.activated, rate: r.entered ? r.activated / r.entered : null },
    weeklyActiveAtLeast3Days: r.weekly_active,
    retentionDays8To14: { eligible: r.retained_eligible, retained: r.retained, rate: r.retained_eligible ? r.retained / r.retained_eligible : null },
    understandingCorrection: { savedRecords: r.saved, correctedRecords: r.corrected, rate: r.saved ? r.corrected / r.saved : null, unclassifiedChanges: r.unclassified },
  };
}
