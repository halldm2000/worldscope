/**
 * Intent Router
 *
 * Three-tier routing strategy:
 *   1. AI classifier (fast, non-streaming): classifies intent and extracts
 *      params for single-command inputs. Executes the command directly
 *      without a full chat round-trip. (~300ms, minimal tokens)
 *   2. AI chat with tool use (streaming): handles conversations, questions,
 *      compound commands, and anything the classifier defers. (~500ms+)
 *   3. Pattern matching fallback: only used when no AI provider is available.
 *      Regex-based, no intelligence, but keeps basic commands working offline.
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
 *
 * Priority: AI classifier -> AI chat -> pattern fallback
 */
export async function route(input: string, history?: ChatMessage[]): Promise<RouteResult> {
  const trimmed = input.trim()
  if (!trimmed) {
    return { tier: 'pattern', params: {} }
  }

  const provider = await findProvider()

  if (provider) {
    // --- Tier 1: AI intent classifier (fast, non-streaming) ---
    // A lightweight prompt asks the AI to classify the input as either a
    // single command (returns command ID + params as JSON) or "chat" (needs
    // the full conversational path). This replaces brittle regex matching
    // with actual language understanding, at minimal token cost.
    const classified = await classifyIntent(provider, trimmed)

    if (classified) {
      console.log(`[router] AI classified: ${classified.commandId}`, classified.params)
      const command = registry.get(classified.commandId)
      if (command) {
        try {
          const result = await command.handler(classified.params)
          // Check for text output (e.g. help, list)
          const output = (command as any)._lastOutput as string | undefined
          if (output) {
            delete (command as any)._lastOutput
            return {
              tier: 'ai-classify',
              command,
              params: classified.params,
              response: (async function* () { yield output })(),
            }
          }
          return {
            tier: 'ai-classify',
            command,
            params: classified.params,
          }
        } catch (err) {
          console.error('[router] Command handler error:', err)
        }
      }
    }

    // --- Tier 2: AI chat with tool use (full conversation) ---
    // Classifier returned null (meaning "chat"), or the command wasn't found.
    // Fall through to the streaming chat path with tool use.
    const response = runAIWithTools(provider, trimmed, history)
    return { tier: 'cloud-chat', response }
  }

  // --- Tier 3: Pattern matching fallback (offline only) ---
  // No AI provider available. Fall back to regex pattern matching so basic
  // commands still work without an API key or network connection.
  const patternMatch = matchPattern(trimmed, registry.getAll())
  if (patternMatch && patternMatch.score >= 0.85) {
    console.log(`[router] Offline fallback match: ${patternMatch.command.id} (score: ${patternMatch.score.toFixed(3)})`)
    try {
      await patternMatch.command.handler(patternMatch.params)
    } catch (err) {
      console.error('[router] Command handler error:', err)
    }

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

  // No provider, no pattern match
  return {
    tier: 'pattern',
    response: (async function* () {
      yield "No AI provider configured. Try a direct command like \"go to Berlin\" or type \"help\" for available commands.\n\nTo enable AI chat: set provider anthropic sk-ant-..."
    })(),
  }
}

// ── Tier 1: AI intent classifier ──

interface ClassifiedIntent {
  commandId: string
  params: Record<string, unknown>
}

/**
 * Lightweight AI call to classify user input as a single command or "chat".
 * Returns null if the input needs the full conversational path.
 *
 * Uses a non-streaming request with a tiny prompt and max_tokens=150.
 * Typical latency: 200-400ms, ~200 input tokens + ~50 output tokens.
 */
async function classifyIntent(
  provider: AIProvider,
  input: string,
): Promise<ClassifiedIntent | null> {
  const commands = registry.getAll().filter(c => !c.aiHidden)
  const commandSummary = commands.map(c => {
    const params = c.params
      .filter(p => p.name !== '_raw')
      .map(p => `${p.name}:${p.type}${p.required ? '' : '?'}`)
      .join(', ')
    return `  ${c.id}(${params}) - ${c.description}`
  }).join('\n')

  const classifierPrompt = `You are a command classifier for a 3D globe app. Given user input, determine if it maps to exactly ONE command, or if it needs a conversational response.

Available commands (use these EXACT IDs only):
${commandSummary}

Rules:
- If the input maps to exactly one command, respond with JSON: {"command":"<exact-id>","params":{...}}
- If it's a question, conversation, compound request (multiple actions), or ambiguous, respond with: {"command":"chat"}
- You MUST use one of the exact command IDs listed above. Do NOT invent command IDs.
- For compound requests like "go to X and show Y", always return {"command":"chat"}
- Respond ONLY with valid JSON, no other text.`

  try {
    // Collect the full response (non-streaming, small output)
    let responseText = ''
    const messages: ChatMessage[] = [{ role: 'user', content: input }]
    const stream = provider.chat(messages, undefined, {
      systemPrompt: classifierPrompt,
      maxTokens: 150,
      temperature: 0,
    })

    for await (const event of stream) {
      if (event.type === 'text') responseText += event.content
      if (event.type === 'error') {
        console.warn('[router] Classifier error, falling through to chat:', event.message)
        return null
      }
    }

    // Parse the JSON response
    const cleaned = responseText.trim().replace(/^```json?\s*/, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(cleaned)

    if (parsed.command === 'chat' || !parsed.command) {
      console.log('[router] Classifier says: chat')
      return null
    }

    console.log(`[router] Classifier says: ${parsed.command}`, parsed.params)
    return {
      commandId: parsed.command,
      params: { ...parsed.params, _raw: input },
    }
  } catch (err) {
    // If classification fails for any reason, fall through to chat
    console.warn('[router] Classifier failed, falling through to chat:', err)
    return null
  }
}

// ── Tier 2: AI chat with tool use ──

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
      if (event.type === 'error') {
        yield `\x00ERR\x00${event.message}`
        return
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
      // Show the user what tool is being called
      const command = registry.get(call.name.replace(/_/, ':')) || registry.get(call.name)
      const toolLabel = command?.name || call.name
      yield `\x00TOOL\x00${toolLabel}\n`

      const result = await executeToolCall(call)
      console.log(`[router] Tool ${call.name}: ${result.content}`)

      // Add tool result to conversation
      messages.push({
        role: 'tool',
        content: result.content,
        toolCallId: call.id,
      })
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
  // Tool names replace colons with underscores (API naming rules).
  // Reverse: core_go-to -> core:go-to, layers_toggle -> layers:toggle
  const commandId = call.name.replace(/_/, ':')
  const command = registry.get(commandId) || registry.get(call.name)
  if (!command) {
    console.warn(`[router] Tool lookup failed: "${call.name}" -> "${commandId}" not in registry`)
    return { content: `Unknown command: ${call.name}`, isError: true }
  }

  try {
    console.log(`[router] Executing: ${command.id}`, JSON.stringify(call.arguments))
    const result = await command.handler(call.arguments)
    const message = typeof result === 'string' ? result : `Executed ${command.name}`
    console.log(`[router] Result: ${message}`)
    return { content: message, isError: false }
  } catch (err) {
    console.error(`[router] Tool error in ${command.id}:`, err)
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
      name: cmd.id.replace(/:/g, '_'),
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

// ── Tier 3: Pattern matching (offline fallback) ──

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
- After using tools, confirm what you did in ONE short sentence. Only add a second sentence if there's something genuinely surprising or useful about the location/data. Do NOT narrate geography facts the user didn't ask about.
- Keep responses concise (1-2 sentences for tool actions, 2-4 for questions) unless the user asks for depth
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
