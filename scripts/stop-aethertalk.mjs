import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const pidFile = path.join(projectRoot, '.runtime', 'aethertalk-dev.pid')

if (!existsSync(pidFile)) {
  console.log('AetherTalk is not currently running.')
  process.exit(0)
}

const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)

if (Number.isNaN(pid)) {
  await rm(pidFile, { force: true })
  console.log('AetherTalk had an invalid PID file, so it was cleaned up.')
  process.exit(0)
}

try {
  process.kill(-pid, 'SIGTERM')
} catch {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Ignore stale pid cleanup below.
  }
}

await rm(pidFile, { force: true })
console.log('AetherTalk has been stopped.')
