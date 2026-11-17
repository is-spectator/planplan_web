import type { Db } from '../db/db.js';
import { checkMigrations } from '../db/migrations.js';

/** Coalesce public probes and bound the response while PG's own timeout cancels work. */
export function readinessProbe(db: Db, now = Date.now) {
  let lastAt = -Infinity, lastReady = false, running: Promise<boolean> | undefined;
  return async (): Promise<boolean> => {
    if (now() - lastAt < 5000) return lastReady;
    if (running) return running;
    running = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          checkMigrations(db),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('readiness_timeout')), 2500); }),
        ]);
        lastReady = true;
      } catch { lastReady = false; }
      finally { clearTimeout(timer); lastAt = now(); running = undefined; }
      return lastReady;
    })();
    return running;
  };
}
