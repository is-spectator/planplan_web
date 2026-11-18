import { readFile, appendFile } from 'node:fs/promises'

const required = [
  'concurrent commit cannot mix old counts with new records in one page',
  'serializes the initial bucket across independent PostgreSQL pools',
]

export function evaluateVitestReport(report) {
  const problems = []
  const results = []
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) results.push(assertion)
  }
  const counts = { passed: 0, failed: 0, skipped: 0 }
  for (const assertion of results) {
    if (assertion.status === 'passed') counts.passed += 1
    else if (assertion.status === 'failed') counts.failed += 1
    else {
      counts.skipped += 1
      problems.push(`skipped ${assertion.fullName ?? assertion.title} (${assertion.status})`)
    }
  }
  if ((report.numFailedTests ?? 0) > 0 && counts.failed === 0) problems.push(`reporter numFailedTests=${report.numFailedTests}`)
  for (const title of required) {
    const match = results.find(assertion => assertion.title === title || assertion.fullName === title)
    if (!match) problems.push(`required test was not collected: ${title}`)
    else if (match.status !== 'passed') problems.push(`required test ${match.status}: ${title}`)
  }
  const lines = [
    `passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped}`,
    'required PostgreSQL cases must pass; skipped tests are not counted as passed',
  ]
  if (problems.length) {
    lines.push('problems:')
    for (const problem of problems) lines.push(`- ${problem}`)
  }
  return { ok: problems.length === 0, summary: `${lines.join('\n')}\n`, problems, counts }
}

if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  const reportPath = process.argv[2] ?? 'ci-artifacts/vitest.json'
  let report
  try { report = JSON.parse(await readFile(reportPath, 'utf8')) }
  catch (error) {
    console.error(`missing vitest report ${reportPath}: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
  const result = evaluateVitestReport(report)
  process.stdout.write(result.summary)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### API\n\n\`\`\`\n${result.summary}\`\`\`\n`)
  if (!result.ok) process.exit(1)
}
