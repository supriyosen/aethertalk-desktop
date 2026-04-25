import { startTransition, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import './App.css'

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

type StreamEvent = {
  payload: AppState
  type: 'snapshot'
}

const initialState: AppState = {
  chats: [],
  selectedChatId: null,
}

function App() {
  const [appState, setAppState] = useState<AppState>(initialState)
  const [isExporting, setIsExporting] = useState(false)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [isSystemLoading, setIsSystemLoading] = useState(true)
  const [systemAction, setSystemAction] = useState<string | null>(null)
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null)
  const chatThreadRef = useRef<HTMLDivElement | null>(null)

  const selectedChat = useMemo(
    () => appState.chats.find((chat) => chat.id === appState.selectedChatId) ?? null,
    [appState.chats, appState.selectedChatId],
  )

  const sortedChats = useMemo(
    () =>
      [...appState.chats].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      ),
    [appState.chats],
  )

  const runningChat = useMemo(
    () => appState.chats.find((chat) => chat.running) ?? null,
    [appState.chats],
  )

  const applySnapshot = useEffectEvent((nextState: AppState) => {
    startTransition(() => {
      setAppState(nextState)
    })
  })

  const applySystemStatus = (nextStatus: SystemStatus) => {
    startTransition(() => {
      setSystemStatus(nextStatus)
    })
  }

  const refreshSystemStatus = async () => {
    const response = await fetch('/api/system/status')
    const data = (await response.json()) as SystemStatus
    applySystemStatus(data)
    setIsSystemLoading(false)
  }

  useEffect(() => {
    let cancelled = false

    const loadState = async () => {
      const [stateResponse, statusResponse] = await Promise.all([
        fetch('/api/state'),
        fetch('/api/system/status'),
      ])
      const data = (await stateResponse.json()) as AppState
      const nextStatus = (await statusResponse.json()) as SystemStatus

      if (!cancelled) {
        startTransition(() => {
          setAppState(data)
          setSystemStatus(nextStatus)
          setIsSystemLoading(false)
        })
      }
    }

    void loadState()

    const eventSource = new EventSource('/api/events')

    const onSnapshot = (event: MessageEvent<string>) => {
      const nextEvent = JSON.parse(event.data) as StreamEvent
      if (nextEvent.type === 'snapshot') {
        applySnapshot(nextEvent.payload)
      }
    }

    eventSource.addEventListener('snapshot', onSnapshot)
    eventSource.onerror = () => {
      eventSource.close()
    }

    return () => {
      cancelled = true
      eventSource.close()
    }
  }, [])

  useEffect(() => {
    const thread = chatThreadRef.current
    if (!thread || !selectedChat) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [selectedChat])

  const startTalk = async () => {
    const response = await fetch('/api/start', {
      method: 'POST',
    })
    const nextState = (await response.json()) as AppState
    startTransition(() => {
      setAppState(nextState)
    })
  }

  const stopTalk = async () => {
    const response = await fetch('/api/stop', {
      method: 'POST',
    })
    const nextState = (await response.json()) as AppState
    startTransition(() => {
      setAppState(nextState)
    })
  }

  const createNewChat = async () => {
    const response = await fetch('/api/chats/new', {
      method: 'POST',
    })
    const nextState = (await response.json()) as AppState
    startTransition(() => {
      setAppState(nextState)
    })
  }

  const deleteSelectedChat = async () => {
    if (!selectedChat || selectedChat.running) {
      return
    }

    const response = await fetch(`/api/chats/${selectedChat.id}`, {
      method: 'DELETE',
    })
    const nextState = (await response.json()) as AppState
    startTransition(() => {
      setAppState(nextState)
    })
    setIsDeleteModalOpen(false)
  }

  const selectChat = async (chatId: string) => {
    if (runningChat && runningChat.id !== chatId) {
      return
    }

    const response = await fetch(`/api/chats/${chatId}/select`, {
      method: 'POST',
    })
    const nextState = (await response.json()) as AppState
    startTransition(() => {
      setAppState(nextState)
    })
  }

  const downloadPdf = async () => {
    if (!selectedChat || selectedChat.messages.length === 0 || isExporting) {
      return
    }

    setIsExporting(true)

    try {
      const { jsPDF } = await import('jspdf')
      const document = new jsPDF({
        format: 'a4',
        unit: 'pt',
      })
      const pageWidth = document.internal.pageSize.getWidth()
      const pageHeight = document.internal.pageSize.getHeight()
      const margin = 48
      const contentWidth = pageWidth - margin * 2
      let cursorY = margin

      const ensureSpace = (heightNeeded: number) => {
        if (cursorY + heightNeeded <= pageHeight - margin) {
          return
        }

        document.addPage()
        cursorY = margin
      }

      document.setFont('helvetica', 'bold')
      document.setFontSize(22)
      document.text(displayTitle(selectedChat), margin, cursorY)
      cursorY += 22

      document.setFont('helvetica', 'normal')
      document.setFontSize(11)
      document.setTextColor(90, 90, 96)
      const summary = [
        formatDateLabel(selectedChat.createdAt),
        selectedChat.completedAt ? `Completed ${formatDateLabel(selectedChat.completedAt)}` : 'Unfinished draft',
        `${selectedChat.messages.length} messages`,
      ].join(' • ')
      const summaryLines = document.splitTextToSize(summary, contentWidth)
      document.text(summaryLines, margin, cursorY)
      cursorY += summaryLines.length * 14 + 20

      selectedChat.messages.forEach((message) => {
        const timestamp = new Date(message.timestamp).toLocaleString()
        const metaLines = document.splitTextToSize(
          `${message.agent} • Turn ${message.turn} • ${timestamp}`,
          contentWidth,
        )
        const bodyLines = document.splitTextToSize(message.text, contentWidth)
        const blockHeight = metaLines.length * 14 + bodyLines.length * 16 + 28

        ensureSpace(blockHeight)

        document.setFont('helvetica', 'bold')
        document.setFontSize(11)
        document.setTextColor(28, 28, 30)
        document.text(metaLines, margin, cursorY)
        cursorY += metaLines.length * 14 + 8

        document.setFont('helvetica', 'normal')
        document.setFontSize(12)
        document.setTextColor(55, 55, 58)
        document.text(bodyLines, margin, cursorY)
        cursorY += bodyLines.length * 16 + 16
      })

      document.save(`${slugify(displayTitle(selectedChat)) || 'chat-history'}.pdf`)
    } finally {
      setIsExporting(false)
    }
  }

  const runSystemAction = async (endpoint: string, actionName: string) => {
    setSystemAction(actionName)

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
      })
      const payload = (await response.json()) as {
        status: SystemStatus
      }

      startTransition(() => {
        setSystemStatus(payload.status)
      })
    } finally {
      setSystemAction(null)
    }
  }

  const canStart =
    !!selectedChat &&
    !!systemStatus?.ready &&
    !selectedChat.running &&
    !selectedChat.completedAt &&
    selectedChat.status !== 'stopping'

  const canStop = !!selectedChat?.running
  const canDelete = !!selectedChat && !selectedChat.running
  const needsCodexInstall = !!systemStatus && !systemStatus.checks.codexInstalled
  const needsCodexLogin = !!systemStatus?.checks.codexInstalled && !systemStatus.checks.codexLoggedIn
  const setupTitle = isSystemLoading
    ? 'Checking your local setup'
    : needsCodexInstall
      ? 'Install Codex once on this Mac'
      : needsCodexLogin
        ? 'Open Codex and sign in once'
        : 'Finishing local setup'
  const setupCopy = isSystemLoading
    ? 'AetherTalk is checking whether Codex is available and whether local chat storage is ready on this device.'
    : needsCodexInstall
      ? 'AetherTalk runs both agents with your local Codex install. Install Codex, then return here.'
      : needsCodexLogin
        ? 'Codex is already installed. Open it once, sign in with your own account, then return here.'
        : 'Almost done. AetherTalk is checking the remaining local setup.'

  return (
    <main className="messages-app">
      <section className="messages-frame">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="sidebar-header-main">
              <div className="sidebar-brand">
                <img className="sidebar-brand-icon" src="/app-icon.svg" alt="AetherTalk app icon" />
                <div>
                  <p className="sidebar-label">Local-first app</p>
                  <h1>AetherTalk</h1>
                </div>
              </div>
              <div className="sidebar-header-copy">
                <p className="sidebar-label">Saved chats</p>
                <p className="sidebar-subtitle">History stays on this device</p>
              </div>
            </div>
            <button
              type="button"
              className="sidebar-action"
              onClick={() => {
                void createNewChat()
              }}
              disabled={!!runningChat}
            >
              New Chat
            </button>
          </div>

          <div className="chat-list">
            {sortedChats.map((chat) => {
              const isSelected = chat.id === selectedChat?.id
              const isLocked = !!runningChat && runningChat.id !== chat.id

              return (
                <button
                  key={chat.id}
                  type="button"
                  className={`chat-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    void selectChat(chat.id)
                  }}
                  disabled={isLocked}
                >
                  <span className="chat-title">{displayTitle(chat)}</span>
                  <span className="chat-date">{formatSidebarDateLabel(chat.completedAt ?? chat.createdAt)}</span>
                  <span className="chat-preview">{describeChatState(chat)}</span>
                  <span className="chat-count">{formatTurnCount(chat.turnCount)}</span>
                </button>
              )
            })}
          </div>
        </aside>

        <section className="conversation-panel">
          <header className="conversation-header">
            <div className="header-leading">
              <div className="contact-stack" aria-hidden="true">
                <span className="contact-avatar avatar-a">A</span>
                <span className="contact-avatar avatar-b">B</span>
              </div>
              <div className="conversation-meta">
                <p className="conversation-title">{selectedChat ? displayTitle(selectedChat) : 'Untitled Chat'}</p>
                <p className="conversation-subtitle">Agent A &amp; Agent B</p>
              </div>
            </div>

            <div className="header-trailing">
              <div className={`status-chip status-${selectedChat?.status ?? 'idle'}`}>
                <span className="status-dot" />
                {selectedChat ? displayStatus(selectedChat) : 'Standing by'}
              </div>
              <div className="turn-chip">Turn {selectedChat?.turnCount ?? 0}</div>
            </div>
          </header>

          <section className="thread-surface">
            <div className="thread-meta-row">
              <span className="thread-day">
                {selectedChat ? formatDateLabel(selectedChat.createdAt) : 'No chat selected'}
              </span>
              <span className="thread-note">
                {selectedChat?.completedAt
                  ? `Finished ${formatDateLabel(selectedChat.completedAt)}`
                  : 'The title stays generic until the chat is stopped.'}
              </span>
            </div>

            <div ref={chatThreadRef} className="chat-thread">
              {!selectedChat || selectedChat.messages.length === 0 ? (
                <div className="empty-thread">
                  <p>Start a new chat and let the two agents begin from nothing.</p>
                  <span>Once you stop the chat, it gets a content-based title and stays in the left sidebar with its date.</span>
                </div>
              ) : (
                selectedChat.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`bubble-row ${message.agent === 'Agent A' ? 'incoming' : 'outgoing'}`}
                  >
                    <div className="speaker-tag">
                      {message.agent}
                      <span className="turn-counter">Turn {message.turn}</span>
                    </div>
                    <div className="message-bubble">
                      <p>{message.text}</p>
                    </div>
                  </article>
                ))
              )}

              {selectedChat?.running && selectedChat.currentSpeaker ? (
                <div className={`bubble-row ${selectedChat.currentSpeaker === 'Agent A' ? 'incoming' : 'outgoing'}`}>
                  <div className="speaker-tag">
                    {selectedChat.currentSpeaker}
                    <span className="turn-counter">Typing</span>
                  </div>
                  <div className="typing-bubble" aria-label={`${selectedChat.currentSpeaker} is thinking`}>
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <footer className="composer-bar">
            <div className="composer-topline">
              <div className="composer-copy">
                <p className="composer-title">Autonomous conversation</p>
                <p className="composer-subtitle">
                  {selectedChat?.running
                    ? `${selectedChat.currentSpeaker ?? 'Agent'} has the next turn.`
                    : selectedChat?.completedAt
                      ? 'This chat is finished. Create a new one to start again.'
                      : 'Start when you want the current untitled chat to begin.'}
                </p>
              </div>

              <div className="composer-actions">
                <button
                  type="button"
                  className="imessage-button ghost-button"
                  onClick={() => {
                    void createNewChat()
                  }}
                  disabled={!!runningChat}
                >
                  New Chat
                </button>
                <button
                  type="button"
                  className="imessage-button delete-button"
                  onClick={() => {
                    setIsDeleteModalOpen(true)
                  }}
                  disabled={!canDelete}
                >
                  Delete Chat
                </button>
                <button
                  type="button"
                  className="imessage-button export-button"
                  onClick={() => {
                    void downloadPdf()
                  }}
                  disabled={!selectedChat || selectedChat.messages.length === 0 || isExporting}
                >
                  {isExporting ? 'Preparing PDF...' : 'Download PDF'}
                </button>
                <button
                  type="button"
                  className="imessage-button start-button"
                  onClick={() => {
                    void startTalk()
                  }}
                  disabled={!canStart}
                >
                  Start Talk
                </button>
                <button
                  type="button"
                  className="imessage-button stop-button"
                  onClick={() => {
                    void stopTalk()
                  }}
                  disabled={!canStop}
                >
                  Stop / Quit
                </button>
              </div>
            </div>

            <div className="composer-footer">
              <p className="composer-privacy">Chats are saved locally on this device only.</p>
              <p className="composer-credit">
                <span>Created by Arya Sen</span>
                <span className="composer-credit-separator">•</span>
                <a href="https://instagram.com/_arya.sen" target="_blank" rel="noreferrer">
                  Instagram @_arya.sen
                </a>
                <span className="composer-credit-separator">•</span>
                <a
                  href="https://www.youtube.com/channel/UCBVYOeBPSweQ0FyzP2kU9uQ"
                  target="_blank"
                  rel="noreferrer"
                >
                  YouTube
                </a>
              </p>
            </div>
          </footer>

          {selectedChat?.error ? <div className="error-toast">{selectedChat.error}</div> : null}
        </section>

        {isSystemLoading || (systemStatus && !systemStatus.ready) ? (
          <section className="setup-overlay">
            <div className="setup-card">
              <img className="setup-icon" src="/app-icon.svg" alt="AetherTalk app icon" />
              <p className="setup-kicker">
                {systemStatus?.appMode === 'desktop' ? 'Desktop setup' : 'Local setup'}
              </p>
              <h2>{setupTitle}</h2>
              <p className="setup-copy">{setupCopy}</p>

              <div className="setup-checks">
                <article className={`setup-check ${systemStatus?.checks.codexInstalled ? 'ready' : 'pending'}`}>
                  <span className="setup-check-badge">
                    {systemStatus?.checks.codexInstalled ? 'Done' : 'Step 1'}
                  </span>
                  <h3>Install Codex</h3>
                  <p>Required once. AetherTalk uses your local Codex runtime for both agents.</p>
                </article>

                <article className={`setup-check ${systemStatus?.checks.codexLoggedIn ? 'ready' : 'pending'}`}>
                  <span className="setup-check-badge">
                    {systemStatus?.checks.codexLoggedIn ? 'Done' : 'Step 2'}
                  </span>
                  <h3>Sign in</h3>
                  <p>Open Codex and sign in with your own account on this Mac.</p>
                </article>

                <article className={`setup-check ${systemStatus?.checks.storageReady ? 'ready' : 'pending'}`}>
                  <span className="setup-check-badge">
                    {systemStatus?.checks.storageReady ? 'Done' : 'Step 3'}
                  </span>
                  <h3>Start chatting</h3>
                  <p>
                    Chats stay only on this device at{' '}
                    <code>{systemStatus?.chatStoragePath ?? 'data/chats.json'}</code>.
                  </p>
                </article>
              </div>

              <div className="setup-actions">
                {!systemStatus?.checks.codexInstalled ? (
                  <button
                    type="button"
                    className="imessage-button start-button"
                    onClick={() => {
                      void runSystemAction('/api/system/open-guide', 'guide')
                    }}
                    disabled={systemAction !== null}
                  >
                    {systemAction === 'guide' ? 'Opening Codex page...' : 'Get Codex'}
                  </button>
                ) : null}

                {systemStatus?.checks.codexInstalled && !systemStatus.checks.codexLoggedIn ? (
                  <button
                    type="button"
                    className="imessage-button start-button"
                    onClick={() => {
                      void runSystemAction('/api/system/open-codex-app', 'app')
                    }}
                    disabled={systemAction !== null}
                  >
                    {systemAction === 'app' ? 'Opening Codex...' : 'Open Codex'}
                  </button>
                ) : null}

                <button
                  type="button"
                  className="imessage-button ghost-button"
                  onClick={() => {
                    void runSystemAction('/api/system/open-storage', 'storage')
                  }}
                  disabled={systemAction !== null}
                >
                  {systemAction === 'storage' ? 'Opening folder...' : 'Open Chats Folder'}
                </button>

                <button
                  type="button"
                  className="imessage-button export-button"
                  onClick={() => {
                    setIsSystemLoading(true)
                    void refreshSystemStatus()
                  }}
                  disabled={systemAction !== null}
                >
                  {isSystemLoading ? 'Checking...' : 'Check Again'}
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </section>

      {isDeleteModalOpen && selectedChat ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            setIsDeleteModalOpen(false)
          }}
        >
          <section
            className="confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-chat-title"
            aria-describedby="delete-chat-description"
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            <p className="modal-kicker">Delete chat</p>
            <h2 id="delete-chat-title">Remove this conversation?</h2>
            <p id="delete-chat-description" className="modal-copy">
              <strong>{displayTitle(selectedChat)}</strong> will be permanently deleted from
              your saved history. This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="imessage-button ghost-button"
                onClick={() => {
                  setIsDeleteModalOpen(false)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="imessage-button delete-button"
                onClick={() => {
                  void deleteSelectedChat()
                }}
              >
                Delete Chat
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}

function displayTitle(chat: ChatSession) {
  if (chat.titleStatus === 'generating') {
    return 'Naming chat...'
  }

  return chat.title ?? 'Untitled Chat'
}

function displayStatus(chat: ChatSession) {
  if (chat.titleStatus === 'generating') {
    return 'Naming chat'
  }

  return {
    error: 'Engine fault',
    idle: chat.completedAt ? 'Finished' : 'Standing by',
    running: 'Conversation live',
    stopping: 'Stopping',
  }[chat.status]
}

function describeChatState(chat: ChatSession) {
  if (chat.titleStatus === 'generating') {
    return 'Generating final title'
  }

  if (chat.running) {
    return `${chat.currentSpeaker ?? 'Agent'} is talking`
  }

  if (chat.completedAt) {
    return 'Completed'
  }

  if (chat.messages.length > 0) {
    return 'Draft chat'
  }

  return 'Untitled and ready'
}

function formatDateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

function formatSidebarDateLabel(value: string) {
  const date = new Date(value)
  const parts = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(date)

  const day = parts.find((part) => part.type === 'day')?.value ?? ''
  const month = parts.find((part) => part.type === 'month')?.value ?? ''
  const year = parts.find((part) => part.type === 'year')?.value ?? ''

  return [day, month, year].filter(Boolean).join(' ')
}

function formatTurnCount(turnCount: number) {
  return `${turnCount} ${turnCount === 1 ? 'turn' : 'turns'}`
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default App
