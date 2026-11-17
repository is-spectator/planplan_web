import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { checkMigrations, migrate } from './migrations.js';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Transaction extends Queryable {
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** 事务内执行；lockKey 不为空时按用户串行化写入。 */
  tx<T>(fn: (q: Transaction) => Promise<T>, lockKey?: string): Promise<T>;
  /** 执行多条语句（建表）。 */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

class PgliteDb implements Db {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly pg: PGlite) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pg.query<T>(sql, params);
    return r.rows;
  }
  tx<T>(fn: (q: Transaction) => Promise<T>): Promise<T> {
    // PGlite 是单连接：把事务排成队列，避免交错。
    const run = this.chain.then(() =>
      this.pg.transaction(async (t) => fn({ query: async <R>(s: string, p: unknown[] = []) => (await t.query<R>(s, p)).rows, exec: async (s) => { await t.exec(s); } })),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }
  async exec(sql: string) {
    await this.pg.exec(sql);
  }
  async close() {
    await this.pg.close();
  }
}

class PoolDb implements Db {
  constructor(private readonly pool: pg.Pool) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(sql, params);
    return r.rows as T[];
  }
  async tx<T>(fn: (q: Transaction) => Promise<T>, lockKey?: string): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (lockKey) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      const out = await fn({ query: async <R>(s: string, p: unknown[] = []) => (await client.query(s, p)).rows as R[], exec: async (s) => { await client.query(s); } });
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  async exec(sql: string) {
    await this.pool.query(sql);
  }
  async close() {
    await this.pool.end();
  }
}

/** DATABASE_URL 以 postgres:// 开头时连真实数据库；否则用 PGlite（目录或内存）。 */
export interface OpenDbOptions {
  migrations?: 'auto' | 'check' | 'none';
  ssl?: { ca: string; rejectUnauthorized: true };
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  onPoolError?: () => void;
  /** 测试用隔离 schema；必须已经存在。 */
  schema?: string;
}

export async function openDb(url = process.env.DATABASE_URL ?? 'pglite://memory', options: OpenDbOptions = {}): Promise<Db> {
  if (options.schema && !/^[a-z][a-z0-9_]{0,62}$/.test(options.schema)) throw new Error('Invalid database schema');
  let db: Db;
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new pg.Pool({ connectionString: url, max: 10,
      ssl: options.ssl, connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
      statement_timeout: options.statementTimeoutMillis ?? 30_000,
      ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}) });
    // Idle-connection failures otherwise become unhandled EventEmitter errors.
    pool.on('error', () => options.onPoolError?.());
    db = new PoolDb(pool);
  } else {
    if (!url.startsWith('pglite://')) throw new Error('DATABASE_URL 必须使用 postgres://、postgresql:// 或 pglite://');
    const dir = url.replace(/^pglite:\/\//, '');
    db = new PgliteDb(dir === 'memory' ? await PGlite.create() : await PGlite.create(dir));
  }
  try {
    if (options.migrations === 'check') await checkMigrations(db);
    else if (options.migrations !== 'none') { await migrate(db); await checkMigrations(db); }
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}
