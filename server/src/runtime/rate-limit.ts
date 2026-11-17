import { createHmac } from 'node:crypto';
import type { Db } from '../db/db.js';
import { DomainError } from '../services/errors.js';

export class SharedRateLimiter {
  constructor(private readonly db: Db, private readonly secret: Uint8Array) {
    if (secret.length < 32) throw new Error('Rate-limit HMAC key requires at least 32 bytes');
  }

  async consume(scope: 'chat' | 'write', userId: string, perMinute: number): Promise<void> {
    if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 1000) throw new Error('Invalid request limit');
    const hash = createHmac('sha256', this.secret).update(`${scope}:${userId}`).digest('hex');
    await this.db.tx(async (q) => {
      // Database clock and advisory transaction lock keep concurrent API processes
      // on the same sliding window, including the first request for a missing row.
      await q.query(`INSERT INTO request_rate_limits (key_hash, hits, expires_at)
        VALUES ($1, ARRAY[]::timestamptz[], now() + interval '1 minute') ON CONFLICT DO NOTHING`, [hash]);
      const [state] = await q.query<{ count: number }>(`UPDATE request_rate_limits SET hits = ARRAY(
        SELECT h FROM unnest(hits) h WHERE h > clock_timestamp() - interval '1 minute'
      ) WHERE key_hash = $1 RETURNING cardinality(hits)::int AS count`, [hash]);
      if (state!.count >= perMinute) throw new DomainError('rate_limited', '操作太频繁了，这次还没有保存，请稍后再试。你的输入已保留。');
      await q.query(`UPDATE request_rate_limits SET hits = array_append(hits, clock_timestamp()), expires_at = clock_timestamp() + interval '1 minute' WHERE key_hash = $1`, [hash]);
    }, `planplan:request-limit:${hash}`);
  }
}

export async function pruneRequestLimits(db: Db): Promise<void> {
  await db.query('DELETE FROM request_rate_limits WHERE expires_at < clock_timestamp()');
}
