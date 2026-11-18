import { createRequire } from 'node:module'
import { appendFile } from 'node:fs/promises'

const require = createRequire(new URL('../../server/package.json', import.meta.url))
const { Client } = require('pg')
const url = process.env.TEST_DATABASE_URL
if (!url) {
  console.error('TEST_DATABASE_URL is required; PGlite-only runs cannot satisfy the PostgreSQL check')
  process.exit(1)
}
const client = new Client({ connectionString: url })
await client.connect()
try {
  const version = await client.query('SHOW server_version')
  const serverVersion = version.rows[0].server_version
  const schemas = await client.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'test_%' ORDER BY nspname")
  const summary = `postgres ${serverVersion}; leftover test schemas=${schemas.rowCount}`
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${summary}\n`)
  if (!serverVersion.startsWith('15.')) {
    console.error('PostgreSQL 15 is required for the backend check')
    process.exit(1)
  }
  if (schemas.rowCount) {
    console.error(schemas.rows.map(row => row.nspname).join('\n'))
    process.exit(1)
  }
} finally {
  await client.end()
}
