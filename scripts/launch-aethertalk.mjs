import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const runtimeDir = path.join(projectRoot, '.runtime')
const pidFile = path.join(runtimeDir, 'aethertalk-dev.pid')
const targetUrl = 'http://localhost:5173/'

await mkdir(runtimeDir, { recursive: true })

if (await isServerReady(targetUrl)) {
  console.log(`AetherTalk is already available on ${targetUrl}`)
  openBrowser(targetUrl)
  process.exit(0)
}

const existingPid = await readPid()

if (existingPid && isProcessAlive(existingPid)) {
  console.log(`AetherTalk is already running on ${targetUrl}`)
  openBrowser(targetUrl)
  process.exit(0)
}

if (existingPid) {
  await rm(pidFile, { force: true })
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const child = spawn(npmCommand, ['run', 'dev'], {
  cwd: projectRoot,
  detached: true,
  stdio: 'ignore',
})

child.unref()

await writeFile(pidFile, `${child.pid}\n`, 'utf8')

const becameReady = await waitForServer(targetUrl, 25000)

if (becameReady) {
  console.log(`AetherTalk is running on ${targetUrl}`)
} else {
  console.log('AetherTalk is starting, but the server took longer than expected to respond.')
}

openBrowser(targetUrl)

async function readPid() {
  if (!existsSync(pidFile)) {
    return null
  }

  try {
    const contents = await readFile(pidFile, 'utf8')
    const pid = Number.parseInt(contents.trim(), 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForServer(url, timeoutMs) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerReady(url)) {
      return true
    }

    await delay(500)
  }

  return false
}

async function isServerReady(url) {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

function openBrowser(url) {
  if (process.platform === 'darwin') {
    spawn('open', [url], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }

  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }

  spawn('xdg-open', [url], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
