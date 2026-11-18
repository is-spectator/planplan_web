import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { liveCredentialEnv, smokeTestTitles } from './classify-web-tests.mjs'

function asPath(testsDir) {
  return typeof testsDir === 'string' ? testsDir : fileURLToPath(testsDir)
}

const projects = ['chromium', 'webkit']

function normalizeFile(file) {
  const unix = String(file).replaceAll('\\', '/')
  const marker = '/tests/'
  const at = unix.lastIndexOf(marker)
  if (at >= 0) return `tests/${unix.slice(at + marker.length)}`
  if (unix.startsWith('tests/')) return unix
  const base = unix.split('/').pop() ?? unix
  return base.endsWith('.spec.ts') ? `tests/${base}` : unix
}

function walk(suite, visit) {
  for (const spec of suite.specs ?? []) visit(suite, spec)
  for (const child of suite.suites ?? []) walk(child, visit)
}

function skipReason(test) {
  const annotation = (test.annotations ?? []).find(item => item.type === 'skip' && item.description)
  if (annotation) return annotation.description
  const error = test.results?.flatMap(result => result.errors ?? []).find(item => item.message)
  return error?.message ?? ''
}

export function credentialProblems(env = process.env) {
  const present = liveCredentialEnv.filter(key => env[key])
  const problems = present.map(key => `${key} is set; protocol and smoke checks must not inherit live credentials`)
  if (env.PLANPLAN_FIXTURE_REAL_AI === '1') problems.push('PLANPLAN_FIXTURE_REAL_AI=1 is refused')
  return problems
}

export async function evaluatePlaywrightReport({ report, suite, testsDir, allowlist, commit = 'unknown' }) {
  const directory = asPath(testsDir)
  const problems = []
  if (suite !== 'protocol' && suite !== 'smoke') problems.push(`unknown suite ${suite}`)
  const filesOnDisk = (await readdir(directory)).filter(name => name.endsWith('.spec.ts')).sort().map(name => `tests/${name}`)
  const smokeSource = await readFile(join(directory, 'ci-smoke.spec.ts'), 'utf8')
  let smokeTitles = []
  try { smokeTitles = smokeTestTitles(smokeSource) }
  catch (error) { problems.push(error instanceof Error ? error.message : String(error)) }

  const seenFiles = new Set()
  const counts = Object.fromEntries(projects.map(project => [project, { passed: 0, failed: 0, skipped: 0 }]))
  const smokeSeen = new Map(smokeTitles.map(title => [title, new Set()]))

  for (const error of report.errors ?? []) problems.push(`playwright error: ${error.message ?? JSON.stringify(error)}`)
  for (const root of report.suites ?? []) {
    walk(root, (suiteNode, spec) => {
      const file = normalizeFile(spec.file || suiteNode.file || root.file || '')
      if (file) seenFiles.add(file)
      for (const test of spec.tests ?? []) {
        const project = test.projectName
        if (!counts[project]) {
          problems.push(`${file} ${spec.title} ran on unexpected project ${project}`)
          continue
        }
        const bucket = counts[project]
        if (test.status === 'expected') bucket.passed += 1
        else if (test.status === 'skipped') {
          bucket.skipped += 1
          const reason = skipReason(test)
          const allowed = (allowlist.skips ?? []).some(item => item.file === file && item.reason === reason)
          if (suite === 'smoke' || !allowed) problems.push(`${project} skipped ${file} :: ${spec.title} (${reason || 'no classified reason'})`)
        } else {
          bucket.failed += 1
          const message = test.results?.flatMap(result => result.errors ?? []).map(item => item.message).find(Boolean) ?? test.status
          problems.push(`${project} ${test.status} ${file} :: ${spec.title}: ${String(message).split('\n')[0]}`)
        }
        if (file === 'tests/ci-smoke.spec.ts' && smokeSeen.has(spec.title) && (test.status === 'expected' || test.status === 'skipped')) {
          smokeSeen.get(spec.title).add(project)
        }
      }
    })
  }

  if (suite === 'protocol') {
    for (const file of filesOnDisk) {
      if (file === 'tests/ci-smoke.spec.ts') continue
      if (!seenFiles.has(file)) problems.push(`protocol run did not collect ${file}`)
    }
    if (seenFiles.has('tests/ci-smoke.spec.ts')) problems.push('protocol run collected ci-smoke; keep it in the smoke job')
    for (const project of projects) {
      const count = counts[project]
      if (count.passed + count.failed === 0) problems.push(`${project} executed no protocol test`)
    }
  }

  if (suite === 'smoke') {
    for (const file of seenFiles) {
      if (file !== 'tests/ci-smoke.spec.ts') problems.push(`smoke run collected ${file}`)
    }
    if (!seenFiles.has('tests/ci-smoke.spec.ts')) problems.push('smoke run did not collect tests/ci-smoke.spec.ts')
    for (const [title, ran] of smokeSeen) {
      for (const project of projects) {
        if (!ran.has(project)) problems.push(`smoke ${project} did not pass ${title}`)
      }
    }
    for (const project of projects) {
      if (counts[project].skipped !== 0) problems.push(`${project} smoke has ${counts[project].skipped} skipped tests`)
      if (counts[project].passed !== smokeTitles.length) problems.push(`${project} smoke passed ${counts[project].passed}, source declares ${smokeTitles.length}`)
    }
  }

  const lines = [`commit: ${commit}`, `suite: ${suite}`]
  for (const project of projects) {
    const count = counts[project]
    lines.push(`${project}: passed=${count.passed} failed=${count.failed} skipped=${count.skipped}`)
  }
  if (problems.length) {
    lines.push('problems:')
    for (const problem of problems) lines.push(`- ${problem}`)
  }
  return { ok: problems.length === 0, summary: `${lines.join('\n')}\n`, problems, counts }
}

export function gitCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
  catch { return 'unknown' }
}
