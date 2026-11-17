import { GROWTH_SCHEMA_SQL } from './growth-schema.js';
import { DUPLICATE_CONFIRMATION_SCHEMA_SQL } from './duplicate-confirmation-schema.js';
import { ENTRY_SCHEMA_SQL } from './entry-schema.js';
import { USAGE_SCHEMA_SQL } from './usage-schema.js';
import { createHash } from 'node:crypto';
import type { Db, Queryable } from './db.js';
import { EMAIL_AUTH_SCHEMA_SQL } from './email-auth-schema.js';
import { SCHEMA_SQL } from './schema.js';
import { LIFECYCLE_DOWN_SQL, LIFECYCLE_SCHEMA_SQL } from './lifecycle-schema.js';
import { PRIVACY_DOWN_SQL, PRIVACY_SCHEMA_SQL } from './privacy-schema.js';
import { AI_USAGE_SCHEMA_SQL } from './ai-usage-schema.js';
import { RATE_LIMIT_SCHEMA_SQL } from './rate-limit-schema.js';
import { TEMPLATE_SCHEMA_SQL } from './template-schema.js';
import { GENERIC_TEMPLATE_SCHEMA_SQL } from './generic-template-schema.js';
import { CREATION_SCHEMA_SQL } from './creation-schema.js';
import { COMMUNITY_SCHEMA_SQL } from './community-schema.js';
import { FEEDBACK_SCHEMA_SQL } from './feedback-schema.js';
import { GENERIC_V2_SCHEMA_SQL } from './generic-v2-schema.js';
import { CREATION_RETIREMENT_SCHEMA_SQL } from './creation-retirement-schema.js';

export interface Migration { version: number; name: string; up: string; down?: string }

/** 已发布迁移不可修改；新增版本追加。003 邮箱认证不提供破坏性 down。 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'v1_baseline', up: SCHEMA_SQL },
  { version: 2, name: 'account_deletion_lifecycle', up: LIFECYCLE_SCHEMA_SQL, down: LIFECYCLE_DOWN_SQL },
  { version: 3, name: 'email_authentication', up: EMAIL_AUTH_SCHEMA_SQL },
  { version: 4, name: 'versioned_ai_disclosure', up: PRIVACY_SCHEMA_SQL, down: PRIVACY_DOWN_SQL },
  { version: 5, name: 'shared_request_limits', up: RATE_LIMIT_SCHEMA_SQL, down: 'DROP TABLE request_rate_limits;' },
  { version: 6, name: 'model_attempt_cost_ledger', up: AI_USAGE_SCHEMA_SQL },
  { version: 7, name: 'private_product_metrics', up: USAGE_SCHEMA_SQL },
  { version: 8, name: 'first_entry_and_clarification_metrics', up: ENTRY_SCHEMA_SQL },
  { version: 9, name: 'form_duplicate_confirmation', up: DUPLICATE_CONFIRMATION_SCHEMA_SQL },
  { version: 10, name: 'growth_house', up: GROWTH_SCHEMA_SQL },
  { version: 11, name: 'reading_template_platform', up: TEMPLATE_SCHEMA_SQL },
  { version: 12, name: 'generic_template_records', up: GENERIC_TEMPLATE_SCHEMA_SQL },
  { version: 13, name: 'private_template_creation', up: CREATION_SCHEMA_SQL },
  { version: 14, name: 'generic_template_v2', up: GENERIC_V2_SCHEMA_SQL },
  { version: 15, name: 'community_template_market', up: COMMUNITY_SCHEMA_SQL },
  { version: 16, name: 'private_feedback_tracking', up: FEEDBACK_SCHEMA_SQL },
  { version: 17, name: 'private_template_retirement', up: CREATION_RETIREMENT_SCHEMA_SQL },
];

const REGISTRY_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;
const checksum = (m: Migration) => createHash('sha256').update(`${m.name}\n${m.up}\n${m.down ?? ''}`).digest('hex');
type Applied = { version: number; name: string; checksum: string };

async function hasTable(q: Queryable, table: string) {
  const [r] = await q.query<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1) AS present`, [table]);
  return r!.present;
}

function validateHistory(applied: Applied[], migrations: readonly Migration[]) {
  for (const [i, row] of applied.entries()) {
    const expected = migrations[i];
    if (!expected || row.version !== expected.version || row.name !== expected.name || row.checksum !== checksum(expected)) {
      throw new Error(`Migration history mismatch at version ${row.version}; do not edit applied migrations`);
    }
  }
}

/** 接管旧库时拒绝缺列/缺约束的未知结构，不用 IF NOT EXISTS 掩盖差异。 */
async function validateBaseline(q: Queryable, options: { allowMissingUndoTracking?: boolean } = {}) {
  const expected: Record<string, string[]> = {
    users: ['id', 'apple_sub', 'dev_name', 'ai_consent', 'ai_consent_at', 'token_version', 'data_version', 'created_at', 'deleted_at'],
    plans: ['id', 'user_id', 'kind', 'name', 'activity', 'status', 'start_date', 'view_config', 'created_at', 'last_activity_at'],
    goal_segments: ['seq', 'plan_id', 'param', 'value', 'from_period', 'to_period', 'operation_id', 'revoked', 'created_at'],
    plan_lifecycle: ['seq', 'plan_id', 'event', 'on_date', 'created_at'],
    records: ['id', 'user_id', 'plan_id', 'kind', 'amount_cents', 'minutes', 'category', 'occurred_on', 'note', 'refund_of', 'source', 'source_message_id', 'input_at', 'version', 'deleted', 'created_at', 'updated_at'],
    operations: ['id', 'user_id', 'client_op_id', 'kind', 'result', 'undo', 'undone', 'undone_records', 'created_at'],
    messages: ['id', 'user_id', 'role', 'text', 'cards', 'scope_plan_id', 'operation_id', 'client_msg_id', 'reply_to', 'created_at'],
    pending_actions: ['id', 'user_id', 'message_id', 'draft', 'status', 'input_at', 'created_at'],
    events: ['seq', 'name', 'props', 'created_at'],
  };
  const columns = await q.query<{ table_name: string; column_name: string; udt_name: string; is_nullable: string }>(`SELECT table_name, column_name, udt_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema()`);
  // The pre-versioned deployment predates this one additive SCHEMA_SQL repair.
  // Permit only its absence; every other baseline check still runs before DDL.
  const missingUndoTracking = !columns.some((c) => c.table_name === 'operations' && c.column_name === 'undone_records');
  const allowedMissing = (table: string, name: string) => options.allowMissingUndoTracking && missingUndoTracking && table === 'operations' && name === 'undone_records';
  for (const [table, names] of Object.entries(expected)) {
    if (names.some((name) => !allowedMissing(table, name) && !columns.some((c) => c.table_name === table && c.column_name === name))) throw new Error(`Legacy schema is incomplete: ${table}; restore or repair before baselining`);
  }
  const criticalTypes: Record<string, Record<string, string>> = {
    users: { id: 'uuid', token_version: 'int4', data_version: 'int4', ai_consent: 'bool', deleted_at: 'timestamptz' },
    plans: { id: 'uuid', user_id: 'uuid', start_date: 'text', view_config: 'jsonb' },
    records: { id: 'uuid', user_id: 'uuid', plan_id: 'uuid', amount_cents: 'int4', minutes: 'int4', occurred_on: 'text', version: 'int4', deleted: 'bool' },
    operations: { id: 'uuid', user_id: 'uuid', client_op_id: 'text', result: 'jsonb', undo: 'jsonb', undone_records: 'jsonb' },
    messages: { id: 'uuid', user_id: 'uuid', client_msg_id: 'text', cards: 'jsonb' },
    pending_actions: { id: 'uuid', user_id: 'uuid', draft: 'jsonb', input_at: 'timestamptz' },
    goal_segments: { seq: 'int4', plan_id: 'uuid', value: 'int4', revoked: 'bool' },
    plan_lifecycle: { seq: 'int4', plan_id: 'uuid', on_date: 'text' },
  };
  for (const [table, specs] of Object.entries(criticalTypes)) for (const [name, type] of Object.entries(specs)) {
    if (allowedMissing(table, name)) continue;
    const c = columns.find((c) => c.table_name === table && c.column_name === name)!;
    if (c.udt_name !== type || (['id', 'user_id', 'plan_id', 'undone_records'].includes(name) && c.is_nullable !== 'NO')) throw new Error(`Legacy schema has incompatible column ${table}.${name}`);
  }
  const foreignKeys = await q.query<{ table_name: string; definition: string }>(`SELECT cl.relname AS table_name, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE c.contype = 'f' AND ns.nspname = current_schema()`);
  for (const [table, column, target] of [
    ['plans', 'user_id', 'users'], ['records', 'user_id', 'users'], ['operations', 'user_id', 'users'],
    ['messages', 'user_id', 'users'], ['pending_actions', 'user_id', 'users'], ['records', 'plan_id', 'plans'],
    ['goal_segments', 'plan_id', 'plans'], ['plan_lifecycle', 'plan_id', 'plans'],
  ]) {
    if (!foreignKeys.some((f) => f.table_name === table && f.definition === `FOREIGN KEY (${column}) REFERENCES ${target}(id) ON DELETE CASCADE`)) throw new Error(`Legacy schema is missing cascading foreign key ${table}.${column}`);
  }
  const indexes = await q.query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()`);
  for (const [name, expectedColumns, predicate] of [
    ['plans_one_ledger', '(user_id)', "(kind = 'ledger'::text)"],
    ['messages_client_id', '(user_id, client_msg_id)', "(role = 'user'::text)"],
  ]) {
    if (!indexes.some((i) => i.indexname === name && i.indexdef.includes('UNIQUE INDEX') && i.indexdef.includes(expectedColumns!) && i.indexdef.endsWith(`WHERE ${predicate}`))) throw new Error(`Legacy schema is missing unique index ${name}`);
  }
  const [key] = await q.query<{ present: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'operations'::regclass AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (user_id, client_op_id)'
  ) AS present`);
  if (!key!.present) throw new Error('Legacy schema is missing operation idempotency constraint');
  return { missingUndoTracking };
}

export async function checkMigrations(db: Queryable, migrations: readonly Migration[] = MIGRATIONS, options: { isolatedRecovery?: boolean } = {}): Promise<void> {
  if (!options.isolatedRecovery) {
    const [gate] = await db.query<{ present: boolean }>(`SELECT to_regclass('planplan_recovery.guard') IS NOT NULL AS present`);
    if (gate!.present) {
      const [state] = await db.query<{ ready: boolean }>('SELECT ready FROM planplan_recovery.guard WHERE singleton = true');
      if (!state?.ready) throw new Error('Recovery is incomplete; keep this database isolated until the deletion ledger is applied');
    }
  }
  if (!await hasTable(db, 'schema_migrations')) throw new Error('Database is not versioned; run db:migrate before starting the service');
  const applied = await db.query<Applied>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  validateHistory(applied, migrations);
  if (applied.length !== migrations.length) throw new Error('Database migrations are pending; run db:migrate before starting the service');
}

export async function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  // PostgreSQL advisory lock serializes deployment processes; PGlite serializes transactions.
  await db.tx(async (q) => {
    await q.exec(REGISTRY_SQL);
    const applied = await q.query<Applied>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    validateHistory(applied, migrations);
    for (const m of migrations.slice(applied.length)) {
      if (m.version === 1 && await hasTable(q, 'users')) {
        const { missingUndoTracking } = await validateBaseline(q, { allowMissingUndoTracking: true });
        if (missingUndoTracking) {
          await q.exec(`ALTER TABLE operations ADD COLUMN undone_records jsonb NOT NULL DEFAULT '[]'::jsonb`);
          await validateBaseline(q);
        }
      }
      else await q.exec(m.up);
      await q.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, checksum(m)]);
    }
  }, 'planplan:schema-migrations');
}

/** 只回退显式支持 down 的最后一个迁移；基础数据和删除历史不可破坏性回滚。 */
export async function rollbackLastMigration(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  await db.tx(async (q) => {
    const applied = await q.query<Applied>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    validateHistory(applied, migrations);
    const last = migrations[applied.length - 1];
    if (!last?.down) throw new Error('This migration cannot be rolled back; use a forward migration');
    await q.exec(last.down);
    await q.query('DELETE FROM schema_migrations WHERE version = $1', [last.version]);
  }, 'planplan:schema-migrations');
}
