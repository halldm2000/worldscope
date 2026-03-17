/**
 * ChatPanel: the AI interface overlay.
 *
 * Three states:
 *   minimized - command bar at bottom-right corner
 *   peek - right-side panel, last few messages
 *   full - right sidebar with scrolling history
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '@/store'
import { route, getProviders } from '@/ai/router'
import { registry } from '@/ai/registry'
import type { PanelState } from '@/ai/types'
import { playPing, playSuccess, toggleMute, warmUp } from '@/audio/sounds'
import { usageTracker, type UsageSnapshot } from '@/ai/usage'

/** Marker to separate reasoning from content in message text */
const THINKING_MARKER = '\x00REASONING\x00'

/** Build display message from tool actions, content, and optional reasoning */
function buildMessage(toolActions: string[], content: string, reasoning: string): string {
  let msg = ''
  if (toolActions.length > 0) {
    msg += toolActions.map(t => `⚡ ${t}`).join('\n') + '\n'
  }
  if (reasoning) {
    msg += THINKING_MARKER + reasoning + THINKING_MARKER
  }
  msg += content
  return msg
}

export function ChatPanel() {
  const panelState = useStore(s => s.panelState)
  const messages = useStore(s => s.messages)
  const inputValue = useStore(s => s.inputValue)
  const statusText = useStore(s => s.statusText)
  const setInputValue = useStore(s => s.setInputValue)
  const addMessage = useStore(s => s.addMessage)
  const updateLastAssistant = useStore(s => s.updateLastAssistant)
  const setStatusText = useStore(s => s.setStatusText)
  const cyclePanelState = useStore(s => s.cyclePanelState)
  const setPanelState = useStore(s => s.setPanelState)
  const isProcessing = useStore(s => s.isProcessing)
  const setIsProcessing = useStore(s => s.setIsProcessing)

  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [activeProvider, setActiveProvider] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // Subscribe to usage updates + track active provider
  useEffect(() => {
    setUsage(usageTracker.getSnapshot())
    const updateProvider = () => {
      const providers = getProviders()
      const first = providers[0]
      setActiveProvider(first?.displayName || 'none')
    }
    updateProvider()
    // Poll provider changes every 2s (provider switches don't emit events)
    const interval = setInterval(updateProvider, 2000)
    const unsub = usageTracker.subscribe((snap) => {
      setUsage(snap)
      updateProvider()
    })
    return () => { clearInterval(interval); unsub() }
  }, [])

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Fade status text after 4 seconds
  useEffect(() => {
    if (statusText) {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
      statusTimerRef.current = setTimeout(() => setStatusText(null), 4000)
    }
    return () => { if (statusTimerRef.current) clearTimeout(statusTimerRef.current) }
  }, [statusText, setStatusText])

  // Global keyboard shortcut: backtick cycles panel, Tab focuses input
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (e.key === '`') {
        e.preventDefault()
        cyclePanelState()
      }
      if (e.key === '/' || e.key === 'Tab') {
        e.preventDefault()
        // Open at least to minimized and focus input
        inputRef.current?.focus()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPanelState('minimized')
        inputRef.current?.blur()
      }
      if (e.key === 'm' || e.key === 'M') {
        toggleMute()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [cyclePanelState, setPanelState])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const text = inputValue.trim()
    if (!text || isProcessing) return

    setInputValue('')
    setIsProcessing(true)

    // Warm up audio on user gesture (required by Chrome autoplay policy)
    await warmUp()

    // Add user message
    addMessage({ role: 'user', content: text })

    // Build history for context.
    // Classifier-handled commands (tagged with `command`) are rewritten so the AI
    // knows what happened but doesn't re-execute them. e.g.:
    //   user: "zoom to 500km" + assistant: "Zoom to altitude" (command: core:zoom-to)
    //   becomes -> assistant: "[Already executed: Zoom to altitude]"
    // This gives the AI full conversational context without triggering duplicate actions.
    const history: { role: 'user' | 'assistant'; content: string }[] = []
    for (const m of messages) {
      if (m.role === 'assistant' && m.command) {
        // Collapse the user+assistant pair into a single context note
        history.push({ role: 'assistant', content: `[Already executed: ${m.content}]` })
      } else if (m.role === 'user' || m.role === 'assistant') {
        // Check if the NEXT message is a classifier confirmation for this user msg
        // If so, rewrite the user msg to indicate it was handled
        const idx = messages.indexOf(m)
        const next = messages[idx + 1]
        if (m.role === 'user' && next?.role === 'assistant' && next.command) {
          // Skip this user message; the assistant note covers it
          continue
        }
        history.push({ role: m.role, content: m.content })
      }
    }

    // Route through AI system
    let result
    try {
      result = await route(text, history)
    } catch (err) {
      console.error('[chat] Route error:', err)
      addMessage({ role: 'assistant', content: `Something went wrong: ${err instanceof Error ? err.message : String(err)}`, isError: true })
      setIsProcessing(false)
      return
    }

    if (result.command && !result.response) {
      // Command was executed (by classifier), show confirmation
      const confirmation = `${result.command.name}`

      // Play appropriate sound based on command category
      // Navigation has no trigger sound (flight rumble handles it)
      const cat = result.command.category
      if (cat === 'navigation') { /* flight rumble covers this */ }
      else if (cat === 'view') playPing()
      else playSuccess()

      if (panelState === 'minimized') {
        setStatusText(confirmation)
      } else {
        // Tag the confirmation so it's excluded from chat history
        addMessage({ role: 'assistant', content: confirmation, command: result.command.id })
      }
    }

    if (result.response) {
      // Streaming or static response (from help, chat, or no-provider message)
      addMessage({ role: 'assistant', content: '' })

      // If minimized, auto-expand to peek so user sees the response
      if (panelState === 'minimized') {
        setPanelState('peek')
      }

      let accumulated = ''
      let reasoning = ''
      let toolActions: string[] = []
      for await (const chunk of result.response) {
        // Check for error marker from router
        if (chunk.startsWith('\x00ERR\x00')) {
          accumulated = chunk.slice(5) // strip marker
          updateLastAssistant(accumulated, true)
          break
        }
        // Check for tool execution marker
        if (chunk.startsWith('\x00TOOL\x00')) {
          const toolName = chunk.slice(6).trim()
          toolActions.push(toolName)
          updateLastAssistant(buildMessage(toolActions, accumulated, reasoning))
          continue
        }
        // Check for reasoning/thinking marker
        if (chunk.startsWith('\x00THINK\x00')) {
          reasoning += chunk.slice(7)
          updateLastAssistant(buildMessage(toolActions, accumulated, reasoning))
          continue
        }
        accumulated += chunk
        updateLastAssistant(buildMessage(toolActions, accumulated, reasoning))
      }
    }

    setIsProcessing(false)
  }, [inputValue, messages, panelState, isProcessing, setInputValue, addMessage, updateLastAssistant, setStatusText, setPanelState, setIsProcessing])

  // Autocomplete suggestions
  const suggestions = inputValue.length > 0
    ? registry.search(inputValue).slice(0, 5)
    : []

  return (
    <div style={containerStyle(panelState)}>
      {/* Message area (peek and full only) */}
      {panelState !== 'minimized' && (
        <div ref={scrollRef} style={messageAreaStyle(panelState)}>
          {messages
            .slice(panelState === 'peek' ? -6 : 0)
            .map(msg => (
              <div key={msg.id} style={messageBubbleStyle(msg.role, msg.isError)}>
                {msg.isError && <span style={errorIconStyle}>!</span>}
                <MarkdownContent content={msg.content || '...'} />
              </div>
            ))
          }
        </div>
      )}

      {/* Status text (minimized only) */}
      {panelState === 'minimized' && statusText && (
        <div style={statusStyle}>{statusText}</div>
      )}

      {/* Autocomplete dropdown */}
      {suggestions.length > 0 && (
        <div style={autocompleteStyle}>
          {suggestions.map(cmd => (
            <div
              key={cmd.id}
              style={autocompleteItemStyle}
              onMouseDown={(e) => {
                e.preventDefault()
                setInputValue(cmd.patterns[0].replace(/\{.*?\}/g, ''))
              }}
            >
              <span style={{ fontWeight: 500 }}>{cmd.name}</span>
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, marginLeft: 8 }}>
                {cmd.description}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Usage indicator (peek and full only) */}
      {panelState !== 'minimized' && usage && usage.sessionRequests > 0 && (
        <div style={usageBarStyle}>
          <span title={`Session: ${usage.sessionInputTokens.toLocaleString()} in / ${usage.sessionOutputTokens.toLocaleString()} out tokens\nLifetime: $${usage.lifetimeCost.toFixed(2)} across ${usage.lifetimeRequests} requests`}>
            ${usage.sessionCost.toFixed(3)} this session ({usage.sessionRequests} req)
          </span>
          {usage.lifetimeCost > usage.sessionCost && (
            <span style={{ opacity: 0.5 }}>
              {' '}| ${usage.lifetimeCost.toFixed(2)} lifetime
            </span>
          )}
        </div>
      )}

      {/* Input bar */}
      <form onSubmit={handleSubmit} style={inputBarStyle}>
        <div
          style={panelToggleStyle}
          onClick={cyclePanelState}
          title="Toggle panel (` key)"
        >
          {panelState === 'minimized' ? '▲' : panelState === 'peek' ? '◆' : '▼'}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          disabled={isProcessing}
          placeholder={isProcessing ? 'Thinking...' : 'Ask anything or type a command... (Tab to focus, ` to expand)'}
          style={{ ...inputStyle, ...(isProcessing ? { opacity: 0.5 } : {}) }}
          onFocus={() => {
            // Don't auto-expand, let user control panel state
          }}
        />
        {activeProvider && (
          <div style={{
            padding: '0 10px',
            fontSize: 10, fontWeight: 500,
            color: 'var(--text-muted, #666)',
            whiteSpace: 'nowrap',
            textTransform: 'capitalize',
          }} title={`Active AI: ${activeProvider}`}>
            {activeProvider}
          </div>
        )}
      </form>
    </div>
  )
}

// --- Markdown rendering ---

/**
 * Lightweight inline markdown renderer. Handles:
 *   **bold**, *italic*, `code`, ```code blocks```, and line breaks.
 * No external dependencies. Returns React elements.
 */
function MarkdownContent({ content }: { content: string }) {
  // Split out reasoning blocks
  const parts = content.split(THINKING_MARKER)
  // parts: [before, reasoning, after] or just [content] if no marker
  const hasReasoning = parts.length >= 3
  const reasoning = hasReasoning ? parts[1] : ''
  const mainContent = hasReasoning ? parts[0] + parts.slice(2).join('') : content

  const rendered = useMemo(() => renderMarkdown(mainContent), [mainContent])

  return (
    <div style={{ lineHeight: 1.5 }}>
      {hasReasoning && <ThinkingBlock content={reasoning} />}
      {rendered}
    </div>
  )
}

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{
      marginBottom: 8,
      borderRadius: 'var(--radius-sm, 6px)',
      border: '1px solid var(--border, rgba(255,255,255,0.1))',
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          width: '100%', padding: '6px 10px',
          background: 'rgba(255,255,255,0.05)',
          border: 'none', cursor: 'pointer',
          color: 'var(--text-muted, #888)', fontSize: 12,
          fontFamily: 'inherit',
        }}
      >
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        Thinking...
      </button>
      {open && (
        <div style={{
          padding: '8px 10px',
          fontSize: 12, color: 'var(--text-muted, #888)',
          whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto',
        }}>
          {content}
        </div>
      )}
    </div>
  )
}

function renderMarkdown(text: string): React.ReactNode[] {
  // Split on code blocks first (```...```)
  const parts = text.split(/(```[\s\S]*?```)/g)
  const result: React.ReactNode[] = []

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.startsWith('```') && part.endsWith('```')) {
      // Code block
      const code = part.slice(3, -3).replace(/^\w*\n/, '') // strip optional language tag
      result.push(
        <pre key={i} style={codeBlockStyle}>
          <code>{code}</code>
        </pre>
      )
    } else {
      // Render inline markdown within paragraphs split by double newlines
      const paragraphs = part.split(/\n\n+/)
      for (let p = 0; p < paragraphs.length; p++) {
        if (p > 0) result.push(<div key={`${i}-br-${p}`} style={{ height: '0.5em' }} />)
        const lines = paragraphs[p].split('\n')
        for (let l = 0; l < lines.length; l++) {
          if (l > 0) result.push(<br key={`${i}-ln-${l}`} />)
          result.push(...renderInline(lines[l], `${i}-${p}-${l}`))
        }
      }
    }
  }

  return result
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // Process: **bold**, *italic*, `code`
  const tokens: React.ReactNode[] = []
  // Regex matches **bold**, *italic*, or `code` (non-greedy)
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let idx = 0

  while ((match = pattern.exec(text)) !== null) {
    // Text before the match
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index))
    }
    if (match[2]) {
      // **bold**
      tokens.push(<strong key={`${keyPrefix}-b${idx}`}>{match[2]}</strong>)
    } else if (match[3]) {
      // *italic*
      tokens.push(<em key={`${keyPrefix}-i${idx}`}>{match[3]}</em>)
    } else if (match[4]) {
      // `code`
      tokens.push(<code key={`${keyPrefix}-c${idx}`} style={inlineCodeStyle}>{match[4]}</code>)
    }
    lastIndex = match.index + match[0].length
    idx++
  }

  // Remaining text
  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex))
  }

  return tokens
}

const codeBlockStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.3)',
  borderRadius: 4,
  padding: '8px 10px',
  margin: '6px 0',
  fontSize: '0.85em',
  fontFamily: 'monospace',
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const inlineCodeStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.2)',
  borderRadius: 3,
  padding: '1px 5px',
  fontSize: '0.9em',
  fontFamily: 'monospace',
}

// --- Styles ---

function containerStyle(state: PanelState): React.CSSProperties {
  const base: React.CSSProperties = {
    position: 'fixed',
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  }

  if (state === 'minimized') {
    return {
      ...base,
      bottom: 16,
      right: 16,
      width: 'min(400px, calc(100vw - 250px))',
    }
  }

  if (state === 'peek') {
    return {
      ...base,
      bottom: 16,
      right: 16,
      width: 'min(420px, calc(100vw - 250px))',
      maxHeight: '40vh',
      background: 'rgba(10, 12, 18, 0.88)',
      backdropFilter: 'blur(20px)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 12,
      justifyContent: 'flex-end',
    }
  }

  // full
  return {
    ...base,
    top: 0,
    right: 0,
    bottom: 0,
    width: 'min(480px, 42vw)',
    background: 'rgba(10, 12, 18, 0.92)',
    backdropFilter: 'blur(20px)',
    borderLeft: '1px solid rgba(255,255,255,0.08)',
  }
}

function messageAreaStyle(state: PanelState): React.CSSProperties {
  return {
    flex: 1,
    overflowY: 'auto',
    padding: state === 'full' ? '16px 16px 8px' : '12px 16px 4px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  }
}

function messageBubbleStyle(role: string, isError?: boolean): React.CSSProperties {
  const isUser = role === 'user'

  if (isError) {
    return {
      padding: '8px 12px',
      borderRadius: 10,
      fontSize: 14,
      lineHeight: 1.5,
      maxWidth: '85%',
      alignSelf: 'flex-start',
      background: 'rgba(220, 60, 60, 0.12)',
      color: 'rgba(255, 180, 180, 0.95)',
      border: '1px solid rgba(220, 60, 60, 0.3)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
    }
  }

  return {
    padding: '8px 12px',
    borderRadius: 10,
    fontSize: 14,
    lineHeight: 1.5,
    maxWidth: '85%',
    alignSelf: isUser ? 'flex-end' : 'flex-start',
    background: isUser ? 'rgba(118, 185, 0, 0.15)' : 'rgba(255,255,255,0.06)',
    color: isUser ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.8)',
    border: isUser ? '1px solid rgba(118, 185, 0, 0.25)' : '1px solid rgba(255,255,255,0.06)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  }
}

const errorIconStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  borderRadius: '50%',
  background: 'rgba(220, 60, 60, 0.4)',
  color: '#ff9999',
  fontSize: 11,
  fontWeight: 700,
  flexShrink: 0,
  marginTop: 1,
}

const statusStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  right: 0,
  marginBottom: 8,
  padding: '6px 14px',
  background: 'rgba(10, 12, 18, 0.85)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  fontSize: 13,
  color: 'rgba(255,255,255,0.7)',
  whiteSpace: 'nowrap',
  animation: 'fadeIn 0.2s ease',
}

const autocompleteStyle: React.CSSProperties = {
  position: 'relative',
  background: 'rgba(10, 12, 18, 0.95)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderBottom: 'none',
  borderRadius: '8px 8px 0 0',
  overflow: 'hidden',
}

const autocompleteItemStyle: React.CSSProperties = {
  padding: '8px 14px',
  fontSize: 13,
  color: 'rgba(255,255,255,0.8)',
  cursor: 'pointer',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
}

const usageBarStyle: React.CSSProperties = {
  padding: '4px 16px',
  fontSize: 11,
  color: 'rgba(255,255,255,0.35)',
  fontFamily: 'monospace',
  textAlign: 'right',
  borderTop: '1px solid rgba(255,255,255,0.04)',
}

const inputBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  background: 'rgba(10, 12, 18, 0.85)',
  backdropFilter: 'blur(20px)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12,
}

const panelToggleStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 10,
  color: 'rgba(255,255,255,0.3)',
  cursor: 'pointer',
  flexShrink: 0,
  borderRadius: 4,
  transition: 'color 0.15s',
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'rgba(255,255,255,0.9)',
  fontSize: 14,
  fontFamily: 'inherit',
  caretColor: '#76B900',
}
