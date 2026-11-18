import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function asPath(testsDir) {
  return typeof testsDir === 'string' ? testsDir : fileURLToPath(testsDir)
}

export const allowlistPath = new URL('./web-skip-allowlist.json', import.meta.url)

/** Credential env that would turn an allowlisted live segment into a real run. */
export const liveCredentialEnv = [
  'PLANPLAN_E2E_EMAIL',
  'PLANPLAN_E2E_PASSWORD',
  'PLANPLAN_E2E_SECOND_EMAIL',
  'PLANPLAN_E2E_SECOND_PASSWORD',
  'PLANPLAN_E2E_STORAGE_STATE',
  'PLANPLAN_CREATION_E2E_EMAIL',
  'PLANPLAN_CREATION_E2E_PASSWORD',
  'PLANPLAN_CREATION_SECOND_EMAIL',
  'PLANPLAN_CREATION_SECOND_PASSWORD',
  'PLANPLAN_CREATION_E2E_STORAGE_STATE',
  'PLANPLAN_GENERIC_E2E_EMAIL',
  'PLANPLAN_GENERIC_E2E_PASSWORD',
  'PLANPLAN_TEMPLATE_E2E_EMAIL',
  'PLANPLAN_TEMPLATE_E2E_PASSWORD',
  'PLANPLAN_PLATFORM_PASSWORD',
]

export async function specFiles(testsDir) {
  const names = (await readdir(asPath(testsDir))).filter(name => name.endsWith('.spec.ts')).sort()
  return names.map(name => `tests/${name}`)
}

/** Last string argument of each test.skip(...) call. Throws if a call has no reason. */
export function liveSkipsInSource(source, file) {
  const found = []
  const needle = 'test.skip('
  let from = 0
  while (true) {
    const at = source.indexOf(needle, from)
    if (at < 0) break
    const line = source.slice(0, at).split('\n').length
    let index = at + needle.length
    let depth = 1
    let quote = ''
    let escaped = false
    let lastString = ''
    let sawString = false
    for (; index < source.length; index += 1) {
      const char = source[index]
      if (quote) {
        if (escaped) { escaped = false; continue }
        if (char === '\\') { escaped = true; continue }
        if (char === quote) quote = ''
        else lastString += char
        continue
      }
      if (char === "'" || char === '"') { quote = char; lastString = ''; sawString = true; continue }
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (!sawString || quote || depth !== 0) throw new Error(`${file}:${line} test.skip has no classified reason`)
    found.push({ file, line, reason: lastString })
    from = index + 1
  }
  return found
}

export function smokeTestTitles(source) {
  if (source.includes('test.skip') || source.includes('test.fixme') || source.includes('describe.skip')) {
    throw new Error('tests/ci-smoke.spec.ts must not skip or fixme')
  }
  const titles = []
  for (const match of source.matchAll(/(?:^|\n)test\(\s*'([^'\n]+)'/g)) titles.push(match[1])
  if (titles.length === 0) throw new Error('tests/ci-smoke.spec.ts has no static test titles')
  if (new Set(titles).size !== titles.length) throw new Error('tests/ci-smoke.spec.ts titles must be unique')
  return titles
}

export async function collectLiveSkips(testsDir) {
  const directory = asPath(testsDir)
  const files = await specFiles(directory)
  const skips = []
  for (const file of files) {
    const source = await readFile(join(directory, file.slice('tests/'.length)), 'utf8')
    if (file === 'tests/ci-smoke.spec.ts') {
      smokeTestTitles(source)
      continue
    }
    skips.push(...liveSkipsInSource(source, file))
  }
  const unique = []
  const seen = new Set()
  for (const skip of skips.sort((a, b) => a.file.localeCompare(b.file) || a.reason.localeCompare(b.reason) || a.line - b.line)) {
    const key = `${skip.file}\0${skip.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ file: skip.file, reason: skip.reason })
  }
  return unique
}

export function allowlistDocument(skips) {
  return {
    note: 'Protocol CI may skip only these existing live segments. A new test.skip fails the check until this file is reviewed and updated. Counts are not pinned.',
    skips,
  }
}

function sameSkips(left, right) {
  if (left.length !== right.length) return false
  return left.every((item, index) => item.file === right[index].file && item.reason === right[index].reason)
}

async function main() {
  const testsDir = fileURLToPath(new URL('../../tests/', import.meta.url))
  const skips = await collectLiveSkips(testsDir)
  const document = allowlistDocument(skips)
  const write = process.argv.includes('--write')
  const check = process.argv.includes('--check')
  if (write) {
    await writeFile(allowlistPath, `${JSON.stringify(document, null, 2)}\n`)
    console.log(`wrote ${skips.length} live skip reasons`)
  }
  if (check) {
    const committed = JSON.parse(await readFile(allowlistPath, 'utf8'))
    if (!sameSkips(committed.skips ?? [], skips)) {
      console.error('web-skip-allowlist.json does not match tests/*.spec.ts')
      console.error(JSON.stringify(skips, null, 2))
      process.exit(1)
    }
    console.log(`live skip allowlist matches source (${skips.length} reasons)`)
  }
  if (!write && !check) console.log(JSON.stringify(document, null, 2))
}

if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) await main()
