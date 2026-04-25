import express, { type Response } from 'express'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type AgentName = 'Agent A' | 'Agent B'
type SessionStatus = 'idle' | 'running' | 'stopping' | 'error'
type TitleStatus = 'untitled' | 'generating' | 'ready'

type ChatMessage = {
  id: string
  agent: AgentName
  text: string
  turn: number
  timestamp: string
}

type ChatSession = {
  completedAt: string | null
  createdAt: string
  currentSpeaker: AgentName | null
  error: string | null
  id: string
  messages: ChatMessage[]
  running: boolean
  status: SessionStatus
  title: string | null
  titleStatus: TitleStatus
  turnCount: number
  updatedAt: string
}

type AppState = {
  chats: ChatSession[]
  selectedChatId: string | null
}

type SystemStatus = {
  appMode: 'browser' | 'desktop'
  chatStoragePath: string
  checks: {
    codexInstalled: boolean
    codexLoggedIn: boolean
    storageReady: boolean
  }
  projectPath: string
  ready: boolean
}

const PORT = Number(process.env.PORT ?? 8787)
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex'
const APP_MODE = process.env.AETHERTALK_APP_MODE === 'desktop' ? 'desktop' : 'browser'
const appRootDir = process.env.AETHERTALK_APP_ROOT_DIR ?? process.cwd()
const helpFilePath = process.env.AETHERTALK_HELP_FILE ?? path.join(appRootDir, 'README.md')
const TURN_DELAY_MS = 900
const MAX_TURNS = 100
const CONTEXT_MESSAGES = 12
const TITLE_CONTEXT_MESSAGES = 24
const app = express()
const distDir = process.env.AETHERTALK_DIST_DIR
  ? path.resolve(process.env.AETHERTALK_DIST_DIR)
  : path.resolve(appRootDir, 'dist')
const dataDir = process.env.AETHERTALK_DATA_DIR
  ? path.resolve(process.env.AETHERTALK_DATA_DIR)
  : path.resolve(appRootDir, 'data')
const stateFile = path.join(dataDir, 'chats.json')

const clients = new Set<Response>()
const state = await loadState()

let stopRequested = false
let activeConversationProcess: ChildProcessWithoutNullStreams | null = null

app.use(express.json())

app.get('/api/state', (_request, response) => {
  response.json(state)
})

app.get('/api/system/status', async (_request, response) => {
  response.json(await getSystemStatus())
})

app.get('/api/events', (_request, response) => {
  response.setHeader('Content-Type', 'text/event-stream')
  response.setHeader('Cache-Control', 'no-cache')
  response.setHeader('Connection', 'keep-alive')
  response.flushHeaders()

  clients.add(response)
  writeSnapshot(response)

  response.on('close', () => {
    clients.delete(response)
  })
})

app.post('/api/chats/new', async (_request, response) => {
  if (getRunningChat()) {
    response.status(409).json(state)
    return
  }

  const chat = createChat()
  state.chats = [chat, ...state.chats]
  state.selectedChatId = chat.id
  await persistState()
  broadcastSnapshot()
  response.json(state)
})

app.post('/api/system/open-codex-login', async (_request, response) => {
  const launched = await openCodexLogin()
  response.json({
    launched,
    status: await getSystemStatus(),
  })
})

app.post('/api/system/open-codex-app', async (_request, response) => {
  const launched = await openCodexApp()
  response.json({
    launched,
    status: await getSystemStatus(),
  })
})

app.post('/api/system/open-storage', async (_request, response) => {
  const launched = await openPathInFinder(dataDir)
  response.json({
    launched,
    status: await getSystemStatus(),
  })
})

app.post('/api/system/open-guide', async (_request, response) => {
  const launched = await openPathInFinder(helpFilePath)
  response.json({
    launched,
    status: await getSystemStatus(),
  })
})

app.post('/api/chats/:chatId/select', async (request, response) => {
  const runningChat = getRunningChat()
  const nextChat = getChatById(request.params.chatId)

  if (!nextChat) {
    response.status(404).json(state)
    return
  }

  if (runningChat && runningChat.id !== nextChat.id) {
    response.status(409).json(state)
    return
  }

  state.selectedChatId = nextChat.id
  await persistState()
  broadcastSnapshot()
  response.json(state)
})

app.delete('/api/chats/:chatId', async (request, response) => {
  const chatToDelete = getChatById(request.params.chatId)

  if (!chatToDelete) {
    response.status(404).json(state)
    return
  }

  if (chatToDelete.running) {
    response.status(409).json(state)
    return
  }

  state.chats = state.chats.filter((chat) => chat.id !== chatToDelete.id)

  if (state.chats.length === 0) {
    const replacementChat = createChat()
    state.chats = [replacementChat]
    state.selectedChatId = replacementChat.id
  } else if (state.selectedChatId === chatToDelete.id) {
    state.selectedChatId = state.chats[0]?.id ?? null
  }

  await persistState()
  broadcastSnapshot()
  response.json(state)
})

app.post('/api/start', async (_request, response) => {
  const selectedChat = getSelectedChat()

  if (!selectedChat) {
    response.status(404).json(state)
    return
  }

  if (selectedChat.completedAt) {
    response.status(409).json(state)
    return
  }

  if (getRunningChat()) {
    response.status(409).json(state)
    return
  }

  stopRequested = false
  selectedChat.currentSpeaker = nextSpeakerForChat(selectedChat)
  selectedChat.error = null
  selectedChat.running = true
  selectedChat.status = 'running'
  selectedChat.updatedAt = new Date().toISOString()

  await persistState()
  broadcastSnapshot()
  void runConversationLoop(selectedChat.id)

  response.json(state)
})

app.post('/api/stop', async (_request, response) => {
  const runningChat = getRunningChat()

  if (!runningChat) {
    response.json(state)
    return
  }

  stopRequested = true
  runningChat.status = 'stopping'
  runningChat.updatedAt = new Date().toISOString()
  await persistState()
  broadcastSnapshot()

  if (activeConversationProcess) {
    const processToStop = activeConversationProcess
    processToStop.kill('SIGTERM')

    setTimeout(() => {
      if (activeConversationProcess === processToStop) {
        processToStop.kill('SIGKILL')
      }
    }, 750)
  }

  response.json(state)
})

if (existsSync(distDir)) {
  app.use(express.static(distDir))

  app.get(/^(?!\/api).*/, (_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`Local conversation server listening on http://localhost:${PORT}`)
})

async function loadState() {
  await mkdir(dataDir, { recursive: true })

  if (!existsSync(stateFile)) {
    const initialState: AppState = {
      chats: [createChat()],
      selectedChatId: null,
    }
    initialState.selectedChatId = initialState.chats[0]?.id ?? null
    await writeFile(stateFile, JSON.stringify(initialState, null, 2))
    return initialState
  }

  const fileContents = await readFile(stateFile, 'utf8')
  const parsedState = JSON.parse(fileContents) as AppState

  const chats = parsedState.chats.map((chat): ChatSession => {
    const nextTitleStatus: TitleStatus = chat.title
      ? 'ready'
      : chat.titleStatus === 'generating'
        ? 'untitled'
        : chat.titleStatus ?? 'untitled'

    return {
      ...chat,
      currentSpeaker: null,
      running: false,
      status: chat.status === 'error' ? 'error' : 'idle',
      titleStatus: nextTitleStatus,
    }
  })

  if (chats.length === 0) {
    chats.push(createChat())
  }

  const selectedChatId = chats.some((chat) => chat.id === parsedState.selectedChatId)
    ? parsedState.selectedChatId
    : chats[0]?.id ?? null

  const normalizedState: AppState = {
    chats,
    selectedChatId,
  }

  await writeFile(stateFile, JSON.stringify(normalizedState, null, 2))
  return normalizedState
}

async function persistState() {
  await writeFile(stateFile, JSON.stringify(state, null, 2))
}

function createChat(): ChatSession {
  const now = new Date().toISOString()

  return {
    completedAt: null,
    createdAt: now,
    currentSpeaker: null,
    error: null,
    id: crypto.randomUUID(),
    messages: [],
    running: false,
    status: 'idle',
    title: null,
    titleStatus: 'untitled',
    turnCount: 0,
    updatedAt: now,
  }
}

function getChatById(chatId: string) {
  return state.chats.find((chat) => chat.id === chatId) ?? null
}

function getSelectedChat() {
  if (!state.selectedChatId) {
    return null
  }

  return getChatById(state.selectedChatId)
}

function getRunningChat() {
  return state.chats.find((chat) => chat.running) ?? null
}

function nextSpeakerForChat(chat: ChatSession): AgentName {
  const lastMessage = chat.messages.at(-1)
  return lastMessage?.agent === 'Agent A' ? 'Agent B' : 'Agent A'
}

async function runConversationLoop(chatId: string) {
  try {
    while (!stopRequested) {
      const chat = getChatById(chatId)

      if (!chat || !chat.running || chat.turnCount >= MAX_TURNS) {
        break
      }

      const nextSpeaker = nextSpeakerForChat(chat)
      chat.currentSpeaker = nextSpeaker
      chat.status = stopRequested ? 'stopping' : 'running'
      chat.updatedAt = new Date().toISOString()
      await persistState()
      broadcastSnapshot()

      const text = await generateReply(nextSpeaker, chat.messages)

      if (stopRequested) {
        break
      }

      const message: ChatMessage = {
        id: crypto.randomUUID(),
        agent: nextSpeaker,
        text,
        turn: chat.turnCount + 1,
        timestamp: new Date().toISOString(),
      }

      chat.messages = [...chat.messages, message]
      chat.turnCount = message.turn
      chat.updatedAt = message.timestamp

      await persistState()
      broadcastSnapshot()
      await delay(TURN_DELAY_MS)
    }

    const chat = getChatById(chatId)
    if (!chat) {
      return
    }

    chat.running = false
    chat.currentSpeaker = null
    chat.status = 'idle'

    if (!stopRequested && chat.turnCount >= MAX_TURNS) {
      chat.error = null
      await persistState()
      broadcastSnapshot()
      await completeChat(chat.id)
      return
    }

    if (stopRequested) {
      chat.error = null
      await persistState()
      broadcastSnapshot()
      await completeChat(chat.id)
      return
    }

    await persistState()
    broadcastSnapshot()
  } catch (error) {
    const chat = getChatById(chatId)

    if (chat && stopRequested) {
      chat.running = false
      chat.currentSpeaker = null
      chat.status = 'idle'
      chat.error = null
      chat.updatedAt = new Date().toISOString()
      await persistState()
      broadcastSnapshot()
      await completeChat(chat.id)
    } else if (chat) {
      chat.error = error instanceof Error ? error.message : 'The local AI process failed.'
      chat.running = false
      chat.currentSpeaker = null
      chat.status = 'error'
      chat.updatedAt = new Date().toISOString()
      await persistState()
      broadcastSnapshot()
    }
  } finally {
    activeConversationProcess = null
    stopRequested = false
  }
}

async function completeChat(chatId: string) {
  const chat = getChatById(chatId)

  if (!chat) {
    return
  }

  const now = new Date().toISOString()
  chat.completedAt = chat.completedAt ?? now
  chat.updatedAt = now
  chat.running = false
  chat.currentSpeaker = null
  chat.status = 'idle'

  if (chat.messages.length === 0) {
    chat.titleStatus = 'untitled'
    await persistState()
    broadcastSnapshot()
    return
  }

  chat.titleStatus = 'generating'
  await persistState()
  broadcastSnapshot()

  try {
    const generatedTitle = await generateTitle(chat.messages)
    chat.title = generatedTitle
    chat.titleStatus = 'ready'
  } catch {
    chat.title = chat.title ?? null
    chat.titleStatus = chat.title ? 'ready' : 'untitled'
  }

  chat.updatedAt = new Date().toISOString()
  await persistState()
  broadcastSnapshot()
}

async function generateReply(agent: AgentName, history: ChatMessage[]) {
  const prompt = buildReplyPrompt(agent, history)
  return runCodexPrompt(prompt, { trackConversationProcess: true })
}

async function generateTitle(messages: ChatMessage[]) {
  const transcriptMessages =
    messages.length > TITLE_CONTEXT_MESSAGES
      ? [...messages.slice(0, TITLE_CONTEXT_MESSAGES / 2), ...messages.slice(-TITLE_CONTEXT_MESSAGES / 2)]
      : messages

  const transcript = transcriptMessages
    .map((message) => `${message.agent}: ${message.text}`)
    .join('\n\n')

  const prompt = [
    'Read the completed conversation below and write a short title that reflects the actual subject that emerged.',
    'Requirements:',
    '- 3 to 6 words',
    '- specific to the conversation content',
    '- no quotes',
    '- no markdown',
    '- no colon',
    '- do not mention agents, AI, chat, conversation, or discussion',
    '- return only the title',
    '',
    transcript,
  ].join('\n')

  const rawTitle = await runCodexPrompt(prompt, { trackConversationProcess: false })
  return sanitizeTitle(rawTitle)
}

function buildReplyPrompt(agent: AgentName, history: ChatMessage[]) {
  const otherAgent = agent === 'Agent A' ? 'Agent B' : 'Agent A'
  const recentHistory = history.slice(-CONTEXT_MESSAGES)
  const transcript =
    recentHistory.length === 0
      ? 'No messages yet.'
      : recentHistory.map((message) => `${message.agent}: ${message.text}`).join('\n\n')

  if (history.length === 0) {
    return [
      `You are ${agent}.`,
      `You are beginning a conversation with ${otherAgent}.`,
      'This is a completely separate chat session with its own isolated history.',
      'Ignore any other chats, titles, summaries, or prior sessions.',
      'No topic, subject, agenda, or rules have been assigned for the conversation.',
      `Speak only to ${otherAgent}, not to any human observer.`,
      'Do not ask a human for input, direction, or a topic. Keep the conversation moving on your own.',
      'Start naturally with the first thing you want to say.',
      'Return only your next message in plain text, with no speaker label and no markdown.',
    ].join('\n')
  }

  return [
    `You are ${agent}.`,
    `You are in an ongoing conversation with ${otherAgent}.`,
    'This is a completely separate chat session with its own isolated history.',
    'Use only the conversation shown below. Ignore any other chats, titles, summaries, or prior sessions.',
    'No topic, subject, agenda, or rules have been assigned for the conversation.',
    `Speak only to ${otherAgent}, not to any human observer.`,
    'Do not ask a human for input, direction, or a topic. Keep the conversation moving on your own.',
    'Reply naturally to the conversation so far.',
    'Keep it readable for a live chat window.',
    'Return only your next message in plain text, with no speaker label and no markdown.',
    '',
    'Recent conversation:',
    transcript,
  ].join('\n')
}

async function runCodexPrompt(
  prompt: string,
  options: {
    trackConversationProcess: boolean
  },
) {
  const tempOutputFile = path.join(os.tmpdir(), `codex-dialogue-${crypto.randomUUID()}.txt`)

  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      CODEX_BIN,
      [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '--color',
        'never',
        '-o',
        tempOutputFile,
        '-',
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    if (options.trackConversationProcess) {
      activeConversationProcess = child
    }

    let stderr = ''

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', async (code, signal) => {
      if (options.trackConversationProcess && activeConversationProcess === child) {
        activeConversationProcess = null
      }

      if (options.trackConversationProcess && (stopRequested || signal === 'SIGTERM')) {
        reject(new Error('Conversation stopped.'))
        return
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || `Codex exited with code ${code ?? 'unknown'}.`))
        return
      }

      try {
        const contents = await readFile(tempOutputFile, 'utf8')
        resolve(contents.trim())
      } catch (error) {
        reject(error)
      }
    })

    child.stdin.end(prompt)
  })
}

function sanitizeTitle(rawTitle: string) {
  const cleanedTitle = rawTitle
    .replace(/["'`]/g, '')
    .replace(/[:]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)

  return cleanedTitle || 'Untitled Chat'
}

function broadcastSnapshot() {
  for (const client of clients) {
    writeSnapshot(client)
  }
}

function writeSnapshot(response: Response) {
  response.write('event: snapshot\n')
  response.write(`data: ${JSON.stringify({ payload: state, type: 'snapshot' })}\n\n`)
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function getSystemStatus(): Promise<SystemStatus> {
  const codexCheck = await runCommand(CODEX_BIN, ['login', 'status'])
  const codexInstalled = codexCheck.ok || codexCheck.errorCode !== 'ENOENT'
  const combinedOutput = `${codexCheck.stdout}\n${codexCheck.stderr}`.trim()
  const codexLoggedIn =
    codexInstalled &&
    /^logged in/i.test(combinedOutput) &&
    !/^not logged in/i.test(combinedOutput)
  const storageReady = existsSync(dataDir) && existsSync(stateFile)

  return {
    appMode: APP_MODE,
    chatStoragePath: stateFile,
    checks: {
      codexInstalled,
      codexLoggedIn,
      storageReady,
    },
    projectPath: process.cwd(),
    ready: codexInstalled && codexLoggedIn && storageReady,
  }
}

async function openCodexLogin() {
  if (process.platform === 'darwin') {
    const scriptPath = path.join(os.tmpdir(), `aethertalk-codex-login-${crypto.randomUUID()}.command`)
    const scriptContents = [
      '#!/bin/zsh',
      `cd ${shellQuote(process.cwd())}`,
      'codex login',
      'echo ""',
      'echo "You can close this window after login finishes."',
      'exec zsh',
    ].join('\n')

    await writeFile(scriptPath, scriptContents, 'utf8')
    await chmod(scriptPath, 0o755)
    return openDetached('open', ['-a', 'Terminal', scriptPath])
  }

  return openDetached(CODEX_BIN, ['login'])
}

async function openCodexApp() {
  return openDetached(CODEX_BIN, ['app'])
}

async function openPathInFinder(targetPath: string) {
  if (process.platform === 'darwin') {
    return openDetached('open', [targetPath])
  }

  if (process.platform === 'win32') {
    return openDetached('cmd', ['/c', 'start', '', targetPath])
  }

  return openDetached('xdg-open', [targetPath])
}

function openDetached(command: string, args: string[]) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function runCommand(command: string, args: string[]) {
  return new Promise<{
    errorCode: string | null
    ok: boolean
    stderr: string
    stdout: string
  }>((resolve) => {
    const child = spawn(command, args, {
      cwd: appRootDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let errorCode: string | null = null

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      errorCode = 'code' in error && typeof error.code === 'string' ? error.code : 'unknown'
    })

    child.on('close', (code) => {
      resolve({
        errorCode,
        ok: code === 0,
        stderr: stderr.trim(),
        stdout: stdout.trim(),
      })
    })
  })
}
