import { expect, it } from 'vitest';
import { Monitor, alertHookFromEnv, observedLlm, type Alert } from '../src/runtime/observability.js';
import { FakeLlm, LlmError } from '../src/ai/llm.js';

it('redacts provider error content and sends only aggregate alerts with a cooldown', async () => {
  const logs: string[] = [], alerts: Alert[] = []; let now = Date.now();
  const monitor = new Monitor({ sink: (s) => logs.push(s), alert: async (a) => { alerts.push(a); }, now: () => now });
  const llm = observedLlm(new FakeLlm(() => new LlmError('timeout', 'sensitive-token user@example.com 午饭20元')), monitor);
  for (let i = 0; i < 5; i++) await expect(llm.plan('private system', 'private input')).rejects.toBeInstanceOf(LlmError);
  expect(alerts).toHaveLength(1); expect(alerts[0]).toMatchObject({ category: 'model', failures: 3, total: 3 });
  expect(logs.join('')).not.toMatch(/sensitive-token|user@example|午饭|private/);
  now += 300_001;
  for (let i = 0; i < 3; i++) monitor.result('model', false);
  expect(alerts).toHaveLength(2);
});
it('forwards the LLM result unchanged; alerts remain disabled unless explicitly enabled', async () => {
  const llm = new FakeLlm(() => ({ reply: 'reply' }));
  const observed = observedLlm(llm, new Monitor({ sink: () => {} }));
  expect((await observed.plan('system', 'user')).turn.reply).toBe('reply');
  expect(llm.calls).toEqual([{ system: 'system', user: 'user' }]);
  expect(alertHookFromEnv({ ALERT_WEBHOOK_URL: 'https://unused.invalid' })).toBeUndefined();
  expect(() => alertHookFromEnv({ ALERTS_ENABLED: '1' })).toThrow('Configure');
  expect(() => alertHookFromEnv({ ALERTS_ENABLED: '1', ALERT_WEBHOOK_URL: 'http://unused.invalid' })).toThrow('HTTPS');
});
