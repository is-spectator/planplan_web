import { LlmError, type Llm } from '../ai/llm.js';

type Category = 'api' | 'model' | 'database';
type Failure = 'internal' | 'unavailable' | 'timeout' | 'invalid_output' | 'billing' | 'unauthorized' | 'rate_limited' | 'invalid_request' | 'accounting_unavailable';
export interface Alert {
  event: 'failure_rate_alert'; category: Category; failures: number; total: number; windowSeconds: 60;
}
type Sink = (line: string) => void;
export interface MonitorOptions { sink?: Sink; alert?: (event: Alert) => Promise<void>; now?: () => number }

/** Explicit fields only: no exception messages, request paths, IDs or input values. */
export class Monitor {
  private readonly counts = new Map<Category, { since: number; total: number; failures: number; alertedAt: number }>();
  private readonly sink: Sink;
  private readonly now: () => number;
  constructor(private readonly options: MonitorOptions = {}) {
    this.sink = options.sink ?? ((line) => console.error(line));
    this.now = options.now ?? Date.now;
  }
  result(category: Category, ok: boolean, latencyMs = 0, failure: Failure = 'internal'): void {
    const time = this.now();
    const previous = this.counts.get(category);
    const state = previous && time - previous.since < 60_000 ? previous : { since: time, total: 0, failures: 0, alertedAt: previous?.alertedAt ?? -Infinity };
    state.total++; if (!ok) state.failures++;
    this.counts.set(category, state);
    if (!ok) this.sink(JSON.stringify({ event: 'service_failure', category, failure,
      latencyMs: Math.max(0, Math.min(300_000, Math.round(latencyMs))), time: new Date(time).toISOString() }));
    if (state.failures >= 3 && state.failures / state.total >= 0.2 && time - state.alertedAt >= 300_000) {
      state.alertedAt = time;
      const alert: Alert = { event: 'failure_rate_alert', category, failures: state.failures, total: state.total, windowSeconds: 60 };
      this.sink(JSON.stringify(alert));
      if (this.options.alert) void this.options.alert(alert).catch(() => this.sink(JSON.stringify({ event: 'alert_delivery_failed' })));
    }
  }
  maintenanceFailure(): void { this.sink(JSON.stringify({ event: 'maintenance_cleanup_failed' })); }
}

export function observedLlm(inner: Llm, monitor: Monitor): Llm {
  return {
    async plan(...args: Parameters<Llm['plan']>) {
      const started = Date.now();
      try {
        const result = await inner.plan(...args);
        monitor.result('model', true, Date.now() - started);
        return result;
      } catch (error) {
        monitor.result('model', false, Date.now() - started, error instanceof LlmError ? error.kind : 'internal');
        throw error;
      }
    },
  };
}

/** Disabled by default. Only a configured, reviewed deployment enables delivery. */
export function alertHookFromEnv(env: NodeJS.ProcessEnv): ((event: Alert) => Promise<void>) | undefined {
  if (env.ALERTS_ENABLED !== '1') return undefined;
  let target: URL;
  try { target = new URL(env.ALERT_WEBHOOK_URL ?? ''); } catch { throw new Error('Configure ALERT_WEBHOOK_URL before enabling alerts'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error('Alert hook must be a credential-free HTTPS URL');
  return async (event) => {
    const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event), redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Alert delivery failed');
    await response.body?.cancel();
  };
}
