import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

if (process.env.PLANPLAN_FIXTURE_REAL_AI === '1') {
  console.error('start-web-fixture: refusing PLANPLAN_FIXTURE_REAL_AI=1')
  process.exit(1)
}

const stripped = [
  'PLANPLAN_FIXTURE_REAL_AI',
  'AI_PROVIDER',
  'QWEN_API_KEY', 'QWEN_BASE_URL', 'QWEN_MODEL', 'QWEN_OUTPUT',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'OPENROUTER_MODEL', 'OPENROUTER_OUTPUT', 'OPENROUTER_TIMEOUT_MS',
  'DATABASE_URL',
  'EMAIL_SMTP_HOST', 'EMAIL_SMTP_PORT', 'EMAIL_SMTP_USER', 'EMAIL_SMTP_PASSWORD', 'EMAIL_SMTP_FROM',
]
const env = { ...process.env }
for (const key of stripped) delete env[key]

let ownedDir = ''
if (!env.PLANPLAN_FIXTURE_DATA_DIR) {
  ownedDir = await mkdtemp(join(tmpdir(), 'planplan-ci-fixture-'))
  env.PLANPLAN_FIXTURE_DATA_DIR = ownedDir
  await mkdir('ci-artifacts', { recursive: true })
  await writeFile('ci-artifacts/fixture-data-dir.txt', `${ownedDir}\n`)
}

console.error(`start-web-fixture: data ${env.PLANPLAN_FIXTURE_DATA_DIR}`)
const fingerprint = spawnSync('pnpm', ['--dir', 'server', 'exec', 'tsx', 'scripts/ai-fingerprint.ts'], { env, stdio: 'inherit' })
if (fingerprint.status !== 0) process.exit(fingerprint.status ?? 1)

const child = spawn('pnpm', ['--dir', 'server', 'exec', 'tsx', 'scripts/web-fixture.ts'], { env, stdio: 'inherit' })
let stopping = false
function stop(signal) {
  if (stopping) return
  stopping = true
  child.kill(signal)
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
child.on('exit', (code, signal) => {
  const finish = async () => {
    if (ownedDir) await rm(ownedDir, { recursive: true, force: true })
    process.exit(code ?? (signal ? 1 : 0))
  }
  finish().catch(error => {
    console.error(error)
    process.exit(code ?? 1)
  })
})
