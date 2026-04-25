import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isDev = !app.isPackaged
const devUrl = 'http://127.0.0.1:5173/'
const packagedPort = 47831
const packagedUrl = `http://127.0.0.1:${packagedPort}/`
const defaultPath = [
  '/Applications/Codex.app/Contents/Resources',
  `${os.homedir()}/.local/bin`,
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':')

let backendProcess = null

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopBackendProcess()
})

app.whenReady().then(async () => {
  try {
    await createMainWindow()
  } catch (error) {
    console.error('Failed to launch AetherTalk desktop shell.', error)
    app.quit()
  }
})

async function createMainWindow() {
  const iconPath = path.join(app.getAppPath(), 'public', 'app-icon.svg')
  const icon = nativeImage.createFromPath(iconPath)

  if (process.platform === 'darwin' && !icon.isEmpty()) {
    app.dock.setIcon(icon)
  }

  const mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f7',
    height: 940,
    icon: icon.isEmpty() ? undefined : icon,
    minHeight: 760,
    minWidth: 1180,
    show: false,
    title: 'AetherTalk',
    width: 1480,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  const targetUrl = isDev ? devUrl : packagedUrl
  const targetOrigin = new URL(targetUrl).origin

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(targetOrigin)) {
      return
    }

    event.preventDefault()
    void shell.openExternal(url)
  })

  try {
    if (!isDev) {
      await startBackendProcess()
    }

    await waitForUrl(targetUrl)
    await mainWindow.loadURL(targetUrl)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown launch failure'
    await mainWindow.loadURL(
      `data:text/html,${encodeURIComponent(buildLaunchErrorMarkup(message, targetUrl))}`,
    )
  }
}

async function startBackendProcess() {
  if (backendProcess && !backendProcess.killed) {
    return
  }

  const appRootPath = app.getAppPath()
  const backendEntry = path.join(appRootPath, 'dist-server', 'index.js')
  const userDataPath = app.getPath('userData')
  const packagedDataDir = path.join(userDataPath, 'data')
  const distPath = path.join(appRootPath, 'dist')
  backendProcess = spawn(process.execPath, [backendEntry], {
    env: {
      ...process.env,
      AETHERTALK_APP_MODE: 'desktop',
      AETHERTALK_APP_ROOT_DIR: userDataPath,
      AETHERTALK_DATA_DIR: packagedDataDir,
      AETHERTALK_DIST_DIR: distPath,
      AETHERTALK_SETUP_GUIDE_URL: 'https://openai.com/codex/get-started/',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: process.env.PATH ? `${defaultPath}:${process.env.PATH}` : defaultPath,
      PORT: String(packagedPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  backendProcess.stdout?.on('data', (chunk) => {
    console.log(`[aethertalk-server] ${chunk.toString().trim()}`)
  })

  backendProcess.stderr?.on('data', (chunk) => {
    console.error(`[aethertalk-server] ${chunk.toString().trim()}`)
  })

  backendProcess.on('exit', () => {
    backendProcess = null
  })
}

function stopBackendProcess() {
  if (!backendProcess || backendProcess.killed) {
    return
  }

  backendProcess.kill('SIGTERM')
}

async function waitForUrl(targetUrl) {
  const startedAt = Date.now()
  const timeoutMs = isDev ? 30000 : 20000

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(targetUrl)
      if (response.ok) {
        return
      }
    } catch {
      // Keep polling until the app is ready.
    }

    await delay(500)
  }

  throw new Error(`AetherTalk could not reach ${targetUrl} in time.`)
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function buildLaunchErrorMarkup(message, targetUrl) {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>AetherTalk</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
            background: #f5f5f7;
            color: #111111;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }

          main {
            width: min(100%, 620px);
            padding: 28px;
            border-radius: 28px;
            background: rgba(255, 255, 255, 0.98);
            box-shadow: 0 24px 70px rgba(17, 24, 39, 0.14);
          }

          p {
            line-height: 1.55;
          }

          code {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          }
        </style>
      </head>
      <body>
        <main>
          <p style="margin:0 0 8px;color:#0b75ff;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">AetherTalk desktop</p>
          <h1 style="margin:0;font-size:32px;line-height:1.05;">The desktop shell launched, but the local app did not become ready.</h1>
          <p style="margin-top:14px;">Expected URL: <code>${targetUrl}</code></p>
          <p style="margin-top:12px;">Reason: <code>${message}</code></p>
          <p style="margin-top:12px;">If this keeps happening, reopen the app after confirming Codex is installed and signed in on this machine.</p>
        </main>
      </body>
    </html>
  `
}
