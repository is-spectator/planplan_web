import { readFile, appendFile } from 'node:fs/promises'
import { evaluatePlaywrightReport, gitCommit, credentialProblems } from './playwright-report.mjs'

const suite = process.argv[2] ?? process.env.PLANPLAN_CI_SUITE
const reportPath = process.argv[3] ?? process.env.PLANPLAN_CI_REPORT ?? 'ci-artifacts/playwright-report.json'
const testsDir = new URL('../../tests/', import.meta.url)
const allowlist = JSON.parse(await readFile(new URL('./web-skip-allowlist.json', import.meta.url), 'utf8'))
let report
try { report = JSON.parse(await readFile(reportPath, 'utf8')) }
catch (error) {
  console.error(`missing playwright report ${reportPath}: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
const isolation = credentialProblems()
const result = await evaluatePlaywrightReport({
  report, suite, testsDir, allowlist, commit: process.env.GITHUB_SHA ?? gitCommit(),
})
const summary = isolation.length
  ? `problems:\n${isolation.map(item => `- ${item}`).join('\n')}\n${result.summary}`
  : result.summary
process.stdout.write(summary)
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### Playwright ${suite}\n\n\`\`\`\n${summary}\`\`\`\n`)
if (!result.ok || isolation.length) process.exit(1)
