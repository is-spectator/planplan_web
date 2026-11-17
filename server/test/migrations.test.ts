import { describe, expect, it } from 'vitest';
import { openTestDb } from './database.js';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { checkMigrations, migrate, MIGRATIONS, rollbackLastMigration } from '../src/db/migrations.js';

describe('版本化迁移', () => {
  it('空库必须先迁移，重复运行不重复应用，并支持可逆迁移 up/down/up', async () => {
    const db = await openTestDb({ migrations: 'none' });
    await expect(checkMigrations(db)).rejects.toThrow('not versioned');
    await migrate(db);
    await migrate(db);
    await checkMigrations(db);
    expect((await db.query('SELECT version FROM schema_migrations')).length).toBe(MIGRATIONS.length);
    const reversible = await openTestDb({ migrations: 'none' });
    const lifecycle = MIGRATIONS.slice(0, 2);
    await migrate(reversible, lifecycle);
    await rollbackLastMigration(reversible, lifecycle);
    await expect(checkMigrations(reversible, lifecycle)).rejects.toThrow('pending');
    await migrate(reversible, lifecycle);
    await checkMigrations(reversible, lifecycle);
  }, 20_000); // Two fresh databases + migration replay; this is fixture setup, not a product latency gate.

  it('接管旧数据库时保留用户和幂等记录，缺少关键约束则拒绝', async () => {
    const db = await openTestDb({ migrations: 'none' });
    await db.exec(SCHEMA_SQL);
    const [user] = await db.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('legacy') RETURNING id`);
    await migrate(db);
    expect(await db.query('SELECT id FROM users')).toEqual([{ id: user!.id }]);
    await checkMigrations(db);
    await db.close();

    const invalid = await openTestDb({ migrations: 'none' });
    await invalid.exec(SCHEMA_SQL);
    await invalid.exec('DROP INDEX plans_one_ledger');
    await expect(migrate(invalid)).rejects.toThrow('missing unique index');
    const [r] = await invalid.query<{ present: boolean }>(`SELECT to_regclass('schema_migrations') IS NOT NULL AS present`);
    expect(r!.present).toBe(false);
  }, 20_000);

  it('已执行迁移校验和不匹配和未知版本都拒绝启动', async () => {
    const db = await openTestDb();
    await db.query(`UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1`);
    await expect(checkMigrations(db)).rejects.toThrow('history mismatch');
    await expect(migrate(db)).rejects.toThrow('history mismatch');
  });

  it('只缺历史撤销跟踪列的旧库可接管，旧操作内容不变且重复迁移安全', async () => {
    const db = await openTestDb({ migrations: 'none' });
    await db.exec(SCHEMA_SQL);
    await db.exec('ALTER TABLE operations DROP COLUMN undone_records');
    const [user] = await db.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('legacy-undo') RETURNING id`);
    await db.query(`INSERT INTO operations (user_id, client_op_id, kind, result, undo, undone)
      VALUES ($1, 'legacy-op', 'record', '{"saved":true,"nested":[null,"旧记录"]}', '{"recordIds":[]}', true)`, [user!.id]);
    const before = await db.query('SELECT id, user_id, client_op_id, kind, result, undo, undone, created_at FROM operations');
    await migrate(db);
    await checkMigrations(db);
    await migrate(db);
    expect(await db.query('SELECT id, user_id, client_op_id, kind, result, undo, undone, created_at FROM operations')).toEqual(before);
    expect(await db.query('SELECT undone_records FROM operations')).toEqual([{ undone_records: [] }]);
    const [column] = await db.query(`SELECT udt_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'operations' AND column_name = 'undone_records'`);
    expect(column).toEqual({ udt_name: 'jsonb', is_nullable: 'NO', column_default: "'[]'::jsonb" });
    expect((await db.query('SELECT version FROM schema_migrations')).length).toBe(MIGRATIONS.length);
  }, 20_000);

  it.each([
    ['unknown missing column', 'ALTER TABLE operations DROP COLUMN undo', 'Legacy schema is incomplete'],
    ['missing unique index', 'DROP INDEX messages_client_id', 'missing unique index'],
    ['missing cascading foreign key', 'ALTER TABLE records DROP CONSTRAINT records_user_id_fkey', 'missing cascading foreign key'],
    ['missing operation idempotency', 'ALTER TABLE operations DROP CONSTRAINT operations_user_id_client_op_id_key', 'missing operation idempotency'],
  ])('已知旧缺列伴随 %s 时全部拒绝，不留下补列或迁移登记', async (_name, damage, error) => {
    const db = await openTestDb({ migrations: 'none' });
    await db.exec(SCHEMA_SQL);
    await db.exec('ALTER TABLE operations DROP COLUMN undone_records');
    await db.exec(damage);
    await expect(migrate(db)).rejects.toThrow(error);
    expect(await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'operations' AND column_name = 'undone_records'`)).toEqual([]);
    expect(await db.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS present`)).toEqual([{ present: false }]);
  }, 20_000);

  it.each([
    ['wrong type', "ALTER TABLE operations ALTER COLUMN undone_records DROP DEFAULT; ALTER TABLE operations ALTER COLUMN undone_records TYPE text USING undone_records::text"],
    ['nullable', 'ALTER TABLE operations ALTER COLUMN undone_records DROP NOT NULL'],
  ])('已有撤销跟踪列为 %s 时不能当作已知缺列修复', async (_name, damage) => {
    const db = await openTestDb({ migrations: 'none' });
    await db.exec(SCHEMA_SQL);
    await db.exec(damage);
    await expect(migrate(db)).rejects.toThrow('incompatible column operations.undone_records');
    expect(await db.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS present`)).toEqual([{ present: false }]);
  }, 20_000);

  it('补列后后续迁移失败时，事务也回退补列和整个迁移历史', async () => {
    const db = await openTestDb({ migrations: 'none' });
    await db.exec(SCHEMA_SQL);
    await db.exec('ALTER TABLE operations DROP COLUMN undone_records');
    await expect(migrate(db, [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: 'injected_failure', up: 'SELECT 1 / 0' }])).rejects.toThrow();
    expect(await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'operations' AND column_name = 'undone_records'`)).toEqual([]);
    expect(await db.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS present`)).toEqual([{ present: false }]);
    await migrate(db);
    await checkMigrations(db);
  }, 20_000);

  it('隔离恢复未完成删除重放时不允许应用启动', async () => {
    // 每个PG fixture只隔离schema，此测试仅在独立PGlite DB创建数据库级恢复闸门。
    const { openDb } = await import('../src/db/db.js');
    const db = await openDb('pglite://memory');
    try {
      await db.exec(`CREATE SCHEMA planplan_recovery; CREATE TABLE planplan_recovery.guard (singleton boolean PRIMARY KEY, ready boolean); INSERT INTO planplan_recovery.guard VALUES (true, false)`);
      await expect(checkMigrations(db)).rejects.toThrow('Recovery is incomplete');
      await checkMigrations(db, undefined, { isolatedRecovery: true });
      await db.query('UPDATE planplan_recovery.guard SET ready = true');
      await checkMigrations(db);
    } finally { await db.close(); }
  }, 20_000); // PostgreSQL matrix also cold-starts WASM once for this database-level isolation fixture.

  it('并发部署只应用一次迁移', async () => {
    const db = await openTestDb({ migrations: 'none' });
    await Promise.all([migrate(db), migrate(db)]);
    await checkMigrations(db);
    expect((await db.query('SELECT version FROM schema_migrations')).length).toBe(MIGRATIONS.length);
  });

  it('邮箱凭据迁移不允许破坏性回退', async () => {
    const db = await openTestDb({ migrations: 'none' });
    const email = MIGRATIONS.filter((m) => m.version <= 3);
    await migrate(db, email);
    await expect(rollbackLastMigration(db, email)).rejects.toThrow('forward migration');
    await checkMigrations(db, email);
  });

  it('有删除历史时不允许回滚并丢失清除凭据', async () => {
    const db = await openTestDb({ migrations: 'none' });
    const lifecycle = MIGRATIONS.slice(0, 2);
    await migrate(db, lifecycle);
    await db.query(`INSERT INTO deletion_jobs (user_id) VALUES (gen_random_uuid())`);
    await expect(rollbackLastMigration(db, lifecycle)).rejects.toThrow('retained deletion requests');
    await checkMigrations(db, lifecycle);
  });
});
