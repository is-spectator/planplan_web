const target = process.env.PROBE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8787'}/readyz`;
try {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  const body = await response.json() as { ok?: unknown };
  if (!response.ok || body.ok !== true) throw new Error();
  console.log(JSON.stringify({ event: 'availability_probe', ok: true }));
} catch {
  console.error(JSON.stringify({ event: 'availability_probe', ok: false }));
  process.exitCode = 1;
}
