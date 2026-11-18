import { mkdirSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

const suite = process.env.PLANPLAN_CI_SUITE ?? 'protocol'
if (suite !== 'protocol' && suite !== 'smoke') throw new Error('PLANPLAN_CI_SUITE must be protocol or smoke')

const webUrl = process.env.PLANPLAN_WEB_URL ?? 'http://127.0.0.1:4173'
const web = new URL(webUrl)
if (!['127.0.0.1', 'localhost'].includes(web.hostname)) throw new Error('PLANPLAN_WEB_URL must be loopback')
const webPort = web.port || (web.protocol === 'https:' ? '443' : '80')
const fixturePort = process.env.PLANPLAN_FIXTURE_PORT ?? '8788'
if (!/^[0-9]+$/.test(fixturePort)) throw new Error('PLANPLAN_FIXTURE_PORT must be a TCP port')
const fixtureUrl = `http://127.0.0.1:${fixturePort}`

mkdirSync('ci-artifacts', { recursive: true })

// One fixture per job. Workers stay at 1 so browser projects do not share its data at the same time.
const webServer = [
  {
    command: 'node scripts/ci/start-web-fixture.mjs',
    url: `${fixtureUrl}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { ...process.env, PLANPLAN_FIXTURE_PORT: fixturePort, PLANPLAN_FIXTURE_WEB_ORIGIN: web.origin },
  },
  {
    command: `npm run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
    url: webUrl,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { ...process.env, PLANPLAN_API_TARGET: fixtureUrl },
  },
]

export default defineConfig({
  testDir: './tests',
  testMatch: suite === 'smoke' ? 'ci-smoke.spec.ts' : '**/*.spec.ts',
  testIgnore: suite === 'protocol' ? '**/ci-smoke.spec.ts' : undefined,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'ci-artifacts/playwright-report.json' }]],
  outputDir: 'ci-artifacts/test-results',
  use: { baseURL: webUrl, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
