import { readFile, rm } from 'node:fs/promises'

const record = 'ci-artifacts/fixture-data-dir.txt'
let directory = ''
try { directory = (await readFile(record, 'utf8')).trim() } catch { directory = '' }
if (!directory.startsWith('/tmp/planplan-ci-fixture-')) {
  console.log('no owned fixture data directory')
  process.exit(0)
}
await rm(directory, { recursive: true, force: true })
await rm(record, { force: true })
console.log(`removed ${directory}`)
