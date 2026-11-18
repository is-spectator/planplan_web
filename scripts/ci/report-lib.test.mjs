import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectLiveSkips } from './classify-web-tests.mjs'
import { evaluatePlaywrightReport, credentialProblems } from './playwright-report.mjs'
import { evaluateVitestReport } from './check-vitest-report.mjs'

const allowlist = {
  skips: [{ file: 'tests/live.spec.ts', reason: '需要隔离账户' }],
}

function report(specs) {
  return {
    errors: [],
    suites: [{
      title: 'tests',
      file: 'tests/live.spec.ts',
      specs: [],
      suites: [{ title: 'group', file: 'tests/live.spec.ts', specs }],
    }],
  }
}

function spec(title, status, project, reason) {
  return {
    title,
    tests: [{
      projectName: project,
      status,
      annotations: reason ? [{ type: 'skip', description: reason }] : [],
      results: [{ status: status === 'expected' ? 'passed' : status, errors: [] }],
    }],
  }
}

async function fixtureDir() {
  const directory = await mkdtemp(join(tmpdir(), 'planplan-ci-tests-'))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'live.spec.ts'), "test.skip(!process.env.PLANPLAN_E2E_EMAIL, '需要隔离账户')\ntest('protocol keeps running', async () => {})\n")
  await writeFile(join(directory, 'ci-smoke.spec.ts'), "test('手动创建学习计划并保存一条记录，刷新后仍在', async () => {})\ntest('手动编辑并保存私人模板，采用后没有记录', async () => {})\n")
  return directory
}

test('unknown skip and skipped smoke fail the gate', async () => {
  const testsDir = await fixtureDir()
  try {
    const skips = await collectLiveSkips(testsDir)
    assert.deepEqual(skips, [{ file: 'tests/live.spec.ts', reason: '需要隔离账户' }])
    const unknown = await evaluatePlaywrightReport({
      report: report([
        spec('protocol keeps running', 'expected', 'chromium'),
        spec('protocol keeps running', 'expected', 'webkit'),
        spec('extra', 'skipped', 'chromium', '暂时跳过'),
        spec('extra', 'expected', 'webkit'),
      ]),
      suite: 'protocol',
      testsDir,
      allowlist,
      commit: 'drill',
    })
    assert.equal(unknown.ok, false)
    assert.match(unknown.summary, /暂时跳过/)
    const skippedSmoke = await evaluatePlaywrightReport({
      report: report([
        spec('手动创建学习计划并保存一条记录，刷新后仍在', 'skipped', 'chromium', '缺配置'),
        spec('手动创建学习计划并保存一条记录，刷新后仍在', 'expected', 'webkit'),
        spec('手动编辑并保存私人模板，采用后没有记录', 'expected', 'chromium'),
        spec('手动编辑并保存私人模板，采用后没有记录', 'expected', 'webkit'),
      ]),
      suite: 'smoke',
      testsDir,
      allowlist,
      commit: 'drill',
    })
    assert.equal(skippedSmoke.ok, false)
    assert.match(skippedSmoke.summary, /缺配置/)
  } finally {
    await rm(testsDir, { recursive: true, force: true })
  }
})

test('classified live skip can be skipped while protocol tests still have to run', async () => {
  const testsDir = await fixtureDir()
  try {
    const result = await evaluatePlaywrightReport({
      report: report([
        spec('protocol keeps running', 'expected', 'chromium'),
        spec('protocol keeps running', 'expected', 'webkit'),
        spec('live', 'skipped', 'chromium', '需要隔离账户'),
        spec('live', 'skipped', 'webkit', '需要隔离账户'),
      ]),
      suite: 'protocol',
      testsDir,
      allowlist,
      commit: 'drill',
    })
    assert.equal(result.ok, true, result.summary)
    assert.match(result.summary, /chromium: passed=1 failed=0 skipped=1/)
  } finally {
    await rm(testsDir, { recursive: true, force: true })
  }
})

test('a skipped required database test is not a pass', () => {
  const failed = evaluateVitestReport({
    numFailedTests: 0,
    testResults: [{
      assertionResults: [
        { title: 'concurrent commit cannot mix old counts with new records in one page', status: 'skipped' },
        { title: 'serializes the initial bucket across independent PostgreSQL pools', status: 'passed' },
      ],
    }],
  })
  assert.equal(failed.ok, false)
  assert.match(failed.summary, /required test skipped/)
  const passed = evaluateVitestReport({
    numFailedTests: 0,
    testResults: [{
      assertionResults: [
        { title: 'concurrent commit cannot mix old counts with new records in one page', status: 'passed' },
        { title: 'serializes the initial bucket across independent PostgreSQL pools', status: 'passed' },
        { title: 'other', status: 'passed' },
      ],
    }],
  })
  assert.equal(passed.ok, true, passed.summary)
})

test('live credentials and the real model flag are refused', () => {
  assert.deepEqual(credentialProblems({}), [])
  assert.equal(credentialProblems({ PLANPLAN_E2E_EMAIL: 'a@planplan.test' }).length, 1)
  assert.match(credentialProblems({ PLANPLAN_FIXTURE_REAL_AI: '1' })[0], /PLANPLAN_FIXTURE_REAL_AI/)
})
