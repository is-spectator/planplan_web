import { defineConfig } from 'vitest/config';

const ci = process.env.CI === 'true' || process.env.CI === '1';

export default defineConfig({
  test: {
    // Each isolated file can cold-start a WASM PostgreSQL instance, including
    // evaluation fixtures in the real-PG matrix. Hosted runners also share CPU
    // with crypto/native setup. This bounded allowance covers test provisioning
    // and cleanup, not product response time. PRD P95 lives in perf/run.ts and
    // device acceptance; never infer latency compliance from a Vitest timeout.
    ...(ci ? { testTimeout: 30_000, hookTimeout: 30_000, maxWorkers: 2 } : {}),
  },
});
