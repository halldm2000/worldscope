/**
 * Intent Router
 *
 * Processes user input through a tiered priority chain:
 *   Tier 0: Pattern matching against registry (instant, <1ms)
 *   Tier 3: AI provider with tool use (500ms+, multi-step capable)
 *
 * The router owns the tool execution loop: it auto-generates tool
 * definitions from the command registry, sends them to the AI provider,
 * executes any tool calls the AI makes, feeds results back, and
 * repeats until the AI produces a final text response.
 */

import { registry } from './registry'
import type {
  AIProvider, CommandEntry, RouteResult, ChatMessage, ChatOptions,
  ToolDef, ToolCall, StreamEvent,
} from './types'

/** Active providers, checked in order */
let providers: AIProvider[] = []

/** Extra system prompt fragments from plugins */
const systemContextFragments: string[] = []

export function registerProvider(provider: AIProvider): void {
  // Replace existing provider with same name
  providers = providers.filter(p => p.name !== provider.name)
  providers.push(provider)
}

export function removeProvider(name: string): void {
  providers = providers.filter(p => p.name !== name)
}

export function getProviders(): AIProvider[] {
  return [...providers]
}

export function addSystemContext(fragment: string): void {
  systemContextFragments.push(fragment)
}

export function removeSystemContext(fragment: string): void {
  const idx = systemContextFragments.indexOf(fragment)
  if (idx >= 0) systemContextFragments.splice(idx, 1)
}

/**
 * Route user input through the tier chain.
 * Returns a RouteResult with either a matched command or a streamed AI response.
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

    // Check if command produced output (e.g. help, list)
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

  // --- Tier 3: AI with tool use ---
  const provider = await findProvider()
  if (provider) {
    const response = runAIWithTools(provider, trimmed, history)
    return { tier: 'cloud-chat', response }
  }

  // No provider available
  return {
    tier: 'pattern',
    response: (async function* () {
      yield "No AI provider configured. Try a direct command like \"go to Berlin\" or type \"help\" for available commands.\n\nTo enable AI chat: set provider anthropic sk-ant-..."
    })(),
  }
}

// ── AI tool use loop ──

/**
 * Run the full AI conversation with tool execution loop.
 * Yields text chunks as they arrive. Handles tool calls internally.
 */
async function* runAIWithTools(
  provider: AIProvider,
  userInput: string,
  history?: ChatMessage[],
): AsyncIterable<string> {
  const systemPrompt = buildSystemPrompt()
  const tools = buildToolDefs()

  // Build conversation: history + new user message
  const messages: ChatMessage[] = []
  if (history && history.length > 0) {
    const recent = history.slice(-10)
    for (const msg of recent) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content })
      }
    }
  }
  messages.push({ role: 'user', content: userInput })

  const MAX_ROUNDS = 5 // safety limit on tool use rounds
  let round = 0

  while (round < MAX_ROUNDS) {
    round++
    const pendingCalls: ToolCall[] = []
    let hasText = false

    // Stream from the provider
    const stream = provider.chat(messages, tools, { systemPrompt })
    for await (const event of stream) {
      if (event.type === 'text') {
        yield event.content
        hasText = true
      }
      if (event.type === 'tool_call') {
        pendingCalls.push(event.call)
      }
    }

    // If no tool calls, we're done
    if (pendingCalls.length === 0) break

    // Execute tool calls and collect results
    console.log(`[router] Round ${round}: executing ${pendingCalls.length} tool call(s)`)

    // Add assistant message with tool calls to conversation
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: pendingCalls,
    })

    for (const call of pendingCalls) {
      const result = await executeToolCall(call)
      console.log(`[router] Tool ${call.name}: ${result.content}`)

      // Add tool result to conversation
      messages.push({
        role: 'tool',
        content: result.content,
        toolCallId: call.id,
      })

      // Show a brief status to the user while the AI processes results
      if (!hasText) {
        yield '' // keep the stream alive
      }
    }

    // Loop back: the provider will see the tool results and continue
  }

  if (round >= MAX_ROUNDS) {
    yield '\n\n(Reached maximum tool use rounds)'
  }
}

/**
 * Execute a single tool call by looking up the command in the registry.
 */
async function executeToolCall(call: ToolCall): Promise<{ content: string; isError: boolean }> {
  const command = registry.get(call.name)
  if (!command) {
    return { content: `Unknown command: ${call.name}`, isError: true }
  }

  try {
    const result = await command.handler(call.arguments)
    const message = typeof result === 'string' ? result : `Executed ${command.name}`
    return { content: message, isError: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: `Error executing ${command.name}: ${message}`, isError: true }
  }
}

// ── Tool definition generation ──

/**
 * Auto-generate tool definitions from the command registry.
 * Every registered command becomes a tool the AI can call.
 */
function buildToolDefs(): ToolDef[] {
  const commands = registry.getAll()
  return commands
    .filter(cmd => !cmd.aiHidden)
    .map(cmd => ({
      name: cmd.id,
      description: `${cmd.name}: ${cmd.description}`,
      parameters: {
        type: 'object' as const,
        properties: Object.fromEntries(
          cmd.params
            .filter(p => p.name !== '_raw')
            .map(p => [p.name, paramToJsonSchema(p)])
        ),
        required: cmd.params
          .filter(p => p.required && p.name !== '_raw')
          .map(p => p.name),
      },
    }))
}

function paramToJsonSchema(param: CommandParam): { type: string; description?: string; enum?: string[] } {
  const schema: { type: string; description?: string; enum?: string[] } = {
    type: param.type === 'enum' ? 'string' : param.type,
  }
  if (param.description) schema.description = param.description
  if (param.type === 'enum' && param.options) schema.enum = param.options
  return schema
}

import type { CommandParam } from './types'

// ── Tier 0: Pattern matching ──

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

  const paramNames: string[] = []
  const regexStr = patternLower.replace(/\{(\w+)\}/g, (_match, name) => {
    paramNames.push(name)
    return '(.+?)'
  })

  // Exact match (no params)
  if (paramNames.length === 0) {
    if (input === patternLower) {
      return { command: cmd, params: { _raw: input }, score: 1.0 }
    }
    if (input.startsWith(patternLower) || patternLower.startsWith(input)) {
      const overlap = Math.min(input.length, patternLower.length)
      const maxLen = Math.max(input.length, patternLower.length)
      return { command: cmd, params: { _raw: input }, score: overlap / maxLen * 0.8 }
    }
    return null
  }

  // Regex match with params
  const greedyRegex = regexStr.replace(/\(\.\+\?\)$/, '(.+)')
  const regex = new RegExp(`^${greedyRegex}$`)
  const match = input.match(regex)

  if (match) {
    const params: Record<string, unknown> = { _raw: input }
    for (let i = 0; i < paramNames.length; i++) {
      const raw = match[i + 1]?.trim()
      const paramDef = cmd.params.find(p => p.name === paramNames[i])
      if (paramDef?.type === 'number') {
        params[paramNames[i]] = parseFloat(raw)
      } else {
        params[paramNames[i]] = raw
      }
    }
    return { command: cmd, params, score: 0.9 + (pattern.length / 200) }
  }

  return null
}

// ── Provider selection ──

async function findProvider(): Promise<AIProvider | null> {
  for (const provider of providers) {
    if (await provider.available()) {
      return provider
    }
  }
  return null
}

// ── System prompt ──

function buildSystemPrompt(): string {
  const commands = registry.getAll()
  const commandList = commands
    .filter(c => !c.aiHidden)
    .map(c => `- "${c.patterns[0]}": ${c.description}`)
    .join('\n')

  let prompt = `You are an AI assistant embedded in Earth Explorer, an interactive 3D globe application built with CesiumJS. You help users explore and understand Earth through data visualization, scientific analysis, and natural conversation.

You have tools available to control the globe directly. When the user asks you to navigate, toggle layers, change maps, or perform any action, use the appropriate tool. You can call multiple tools in sequence.

Available commands (users can also type these directly):
${commandList}

Your role:
- Answer questions about geography, Earth science, meteorology, climate, remote sensing, and related topics
- Use tools to take actions on the globe (navigate, toggle layers, switch maps) when the user's intent implies it
- After using tools, briefly describe what you did and any interesting context about what's now visible
- Keep responses concise (2-4 sentences) unless the user asks for depth
- You are knowledgeable about NVIDIA Earth-2, weather/climate AI models, and scientific computing
- Use commas or parentheses instead of em dashes
- Be direct and informative, not chatty

Data layers:
The app supports toggleable data overlays. Currently available: country borders (yellow), coastlines (cyan), major rivers (blue). The layer system supports GeoJSON vectors, imagery tiles, and 3D tilesets. More layers and data sources are added as plugins.

Base maps:
Available styles: default (satellite with labels), satellite (no labels), dark (CartoDB Dark Matter), light (CartoDB Positron), road (road map with labels).`

  // Append plugin system context
  if (systemContextFragments.length > 0) {
    prompt += '\n\n' + systemContextFragments.join('\n\n')
  }

  return prompt
}
