/**
 * ChatPanel: the AI interface overlay.
 *
 * Three states:
 *   minimized - command bar at bottom-right corner
 *   peek - right-side panel, last few messages
 *   full - right sidebar with scrolling history
 */

import { useRef, useEffect, useCallback } from 'react'
import { useStore } from '@/store'
import { route } from '@/ai/router'
import { registry } from '@/ai/registry'
import type { PanelState } from '@/ai/types'
import { playClick, playWhoosh, playPing, playSuccess, toggleMute } from '@/audio/sounds'

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

  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>()

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
    if (!text) return

    setInputValue('')
    playClick()

    // Add user message
    addMessage({ role: 'user', content: text })

    // Build history for context
    const history = messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    // Route through AI system
    const result = await route(text, history)

    if (result.command && !result.response) {
      // Command was executed, show confirmation
      const confirmation = `${result.command.name}`

      // Play appropriate sound based on command category
      const cat = result.command.category
      if (cat === 'navigation') playWhoosh()
      else if (cat === 'view') playPing()
      else playSuccess()

      if (panelState === 'minimized') {
        setStatusText(confirmation)
      } else {
        addMessage({ role: 'assistant', content: confirmation })
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
      for await (const chunk of result.response) {
        accumulated += chunk
        updateLastAssistant(accumulated)
      }
    }
  }, [inputValue, messages, panelState, setInputValue, addMessage, updateLastAssistant, setStatusText, setPanelState])

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
              <div key={msg.id} style={messageBubbleStyle(msg.role)}>
                {msg.content || '...'}
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
          placeholder="Ask anything or type a command... (Tab to focus, ` to expand)"
          style={inputStyle}
          onFocus={() => {
            // Don't auto-expand, let user control panel state
          }}
        />
      </form>
    </div>
  )
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

function messageBubbleStyle(role: string): React.CSSProperties {
  const isUser = role === 'user'
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
