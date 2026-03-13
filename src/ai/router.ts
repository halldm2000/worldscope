/**
 * Intent Router
 *
 * Processes user input through a tiered priority chain:
 *   Tier 0: Pattern matching against registry (instant)
 *   Tier 1: Local classifier (future, for ambiguous inputs)
 *   Tier 2: Local conversational model (future)
 *   Tier 3: Cloud reasoning model (Claude)
 *
 * Currently implements Tier 0 + Tier 3 (cloud fallback).
 */

import { registry } from './registry'
import type { AIProvider, CommandEntry, RouteResult, ChatMessage, ChatOptions } from './types'

/** Active providers, checked in order */
let providers: AIProvider[] = []

export function registerProvider(provider: AIProvider): void {
  providers.push(provider)
  // Sort: browser first (fastest), then local, then cloud
  const order = { browser: 0, local: 1, cloud: 2 }
  providers.sort((a, b) => order[a.tier] - order[b.tier])
}

export function removeProvider(name: string): void {
  providers = providers.filter(p => p.name !== name)
}

export function getProviders(): AIProvider[] {
  return [...providers]
}

/**
 * Route user input through the tier chain.
 * Accepts recent chat history for context in cloud conversations.
 */
export async function route(input: string, history?: ChatMessage[]): Promise<RouteResult> {
  const trimmed = input.trim()
  if (!trimmed) {
    return { tier: 'pattern', params: {} }
  }

  // --- Tier 0: Pattern matching ---
  const patternMatch = matchPattern(trimmed, registry.getAll())
  if (patternMatch) {
    console.log('[router] Tier 0 match:', patternMatch.command.id, patternMatch.params)
    try {
      await patternMatch.command.handler(patternMatch.params)
    } catch (err) {
      console.error('[router] Command handler error:', err)
    }

    // Check if command produced output (e.g. help)
    const output = (patternMatch.command as any)._lastOutput as string | undefined
    if (output) {
      delete (patternMatch.command as any)._lastOutput
      return {
        tier: 'pattern',
        command: patternMatch.command,
        params: patternMatch.params,
        response: (async function* () { yield output })(),
      }
    }

    return {
      tier: 'pattern',
      command: patternMatch.command,
      params: patternMatch.params,
    }
  }

  // --- Tier 3: Cloud chat (skip Tier 1/2 for now) ---
  const chatProvider = await findChatProvider()
  if (chatProvider) {
    const systemPrompt = buildSystemPrompt()

    // Build messages with recent history for context
    const messages: ChatMessage[] = []
    if (history && history.length > 0) {
      // Include last 10 messages for context
      const recent = history.slice(-10)
      for (const msg of recent) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content })
        }
      }
    }
    messages.push({ role: 'user', content: trimmed })

    const response = chatProvider.chat(messages, { systemPrompt })
    return {
      tier: 'cloud-chat',
      response,
    }
  }

  // No provider available, return a static message
  return {
    tier: 'pattern',
    response: (async function* () {
      yield "No AI provider configured. Try a direct command like \"go to Berlin\" or type \"help\" for available commands.\n\nTo enable AI chat, add VITE_ANTHROPIC_API_KEY to your .env file, or type: set key sk-ant-..."
    })(),
  }
}

// --- Tier 0: Pattern matching ---

interface PatternMatch {
  command: CommandEntry
  params: Record<string, unknown>
  score: number
}

function matchPattern(input: string, commands: CommandEntry[]): PatternMatch | null {
  const lower = input.toLowerCase()
  let best: PatternMatch | null = null

  for (const cmd of commands) {
    for (const pattern of cmd.patterns) {
      const result = tryMatch(lower, pattern, cmd)
      if (result && (!best || result.score > best.score)) {
        best = result
      }
    }
  }

  return best
}

/**
 * Try to match user input against a pattern like "go to {place}".
 * Returns extracted params and a confidence score.
 */
function tryMatch(input: string, pattern: string, cmd: CommandEntry): PatternMatch | null {
  const patternLower = pattern.toLowerCase()

  // Extract param placeholders from pattern
  const paramNames: string[] = []
  const regexStr = patternLower.replace(/\{(\w+)\}/g, (_match, name) => {
    paramNames.push(name)
    return '(.+?)'
  })

  // Exact match (no params)
  if (paramNames.length === 0) {
    if (input === patternLower) {
      return { command: cmd, params: {}, score: 1.0 }
    }
    // Prefix match with lower score
    if (input.startsWith(patternLower) || patternLower.startsWith(input)) {
      const overlap = Math.min(input.length, patternLower.length)
      const maxLen = Math.max(input.length, patternLower.length)
      return { command: cmd, params: {}, score: overlap / maxLen * 0.8 }
    }
    return null
  }

  // Regex match with params
  // Make the last param greedy (capture rest of string)
  const greedyRegex = regexStr.replace(/\(\.\+\?\)$/, '(.+)')
  const regex = new RegExp(`^${greedyRegex}$`)
  const match = input.match(regex)

  if (match) {
    const params: Record<string, unknown> = {}
    for (let i = 0; i < paramNames.length; i++) {
      const raw = match[i + 1]?.trim()
      const paramDef = cmd.params.find(p => p.name === paramNames[i])
      if (paramDef?.type === 'number') {
        params[paramNames[i]] = parseFloat(raw)
      } else {
        params[paramNames[i]] = raw
      }
    }
    // Longer patterns are more specific, give higher score
    return { command: cmd, params, score: 0.9 + (pattern.length / 200) }
  }

  return null
}

// --- Provider selection ---

async function findChatProvider(): Promise<AIProvider | null> {
  for (const provider of providers) {
    if (await provider.available()) {
      return provider
    }
  }
  return null
}

// --- System prompt for chat providers ---

function buildSystemPrompt(): string {
  const commands = registry.getAll()
  const commandList = commands
    .filter(c => c.id !== 'core:set-key') // Don't expose key command to AI
    .map(c => `- "${c.patterns[0]}": ${c.description}`)
    .join('\n')

  return `You are an AI assistant embedded in Earth Explorer, an interactive 3D globe application built with CesiumJS. You help users explore and understand Earth through data visualization, scientific analysis, and natural conversation.

Available commands the user can type directly:
${commandList}

Your role:
- Answer questions about geography, Earth science, meteorology, climate, remote sensing, and related topics
- Keep responses concise (2-4 sentences) unless the user is clearly in research mode asking for depth
- When a user asks about a place, you can mention interesting facts about it
- You are knowledgeable about NVIDIA Earth-2, weather/climate AI models, and scientific computing
- Use commas or parentheses instead of em dashes
- Be direct and informative, not chatty`
}
