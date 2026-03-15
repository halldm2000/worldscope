/**
 * Core types for the AI system.
 * Providers, commands, tools, intents, and routing.
 */

// --- Chat messages ---

/** A content block that can be text or an image (for vision). */
export interface ImageContent {
  type: 'image'
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  /** Base64-encoded image data */
  data: string
}

export interface TextContent {
  type: 'text'
  text: string
}

export type ContentBlock = TextContent | ImageContent

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** Simple text content, or rich content blocks (text + images) */
  content: string | ContentBlock[]
  /** For tool result messages: which tool call this is a response to */
  toolCallId?: string
  /** For assistant messages that include tool calls */
  toolCalls?: ToolCall[]
}

// --- Tool use ---

export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, {
      type: string
      description?: string
      enum?: string[]
    }>
    required?: string[]
  }
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  id: string
  content: string
  isError?: boolean
}

// --- Stream events (provider-agnostic) ---

export interface UsageData {
  inputTokens: number
  outputTokens: number
  model: string
}

export type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: UsageData }
  | { type: 'error'; message: string }
  | { type: 'done' }

// --- Provider interface ---

export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
}

export interface AIProvider {
  readonly name: string

  available(): Promise<boolean>

  /**
   * Chat with optional tool use.
   * Yields StreamEvents: text chunks interspersed with tool call requests.
   * The router handles executing tool calls and feeding results back.
   */
  chat(
    messages: ChatMessage[],
    tools?: ToolDef[],
    options?: ChatOptions,
  ): AsyncIterable<StreamEvent>
}

// --- Command registry types ---

export interface CommandParam {
  name: string
  type: 'string' | 'number' | 'boolean' | 'enum'
  required?: boolean
  description?: string
  /** For enum type */
  options?: string[]
  /** For number type */
  range?: [number, number]
  unit?: string
}

export interface CommandEntry {
  /** Unique identifier, e.g. "core:go-to" or "flood-sim:set-water-level" */
  id: string
  /** Human-readable name */
  name: string
  /** Which module owns this command */
  module: string
  /** Short description for autocomplete / help */
  description: string
  /** Example phrases that trigger this command */
  patterns: string[]
  /** Parameters this command accepts */
  params: CommandParam[]
  /** The function to execute. Returns an optional string result (or ContentBlock[] for images). */
  handler: (params: Record<string, unknown>) => void | string | ContentBlock[] | Promise<void | string | ContentBlock[]>
  /** Optional: command category for grouping in help */
  category?: 'navigation' | 'view' | 'data' | 'audio' | 'system' | 'feature'
  /** If true, this command is hidden from AI tool generation (e.g. set-key) */
  aiHidden?: boolean
  /** If true, always route through AI chat (Tier 2), never the fast classifier.
   *  Use for tools whose results need AI interpretation (e.g. screenshot -> vision). */
  chatOnly?: boolean
}

// --- Router types ---

export type RoutingTier = 'pattern' | 'ai-classify' | 'classify' | 'local-chat' | 'cloud-chat'

export interface RouteResult {
  tier: RoutingTier
  /** If matched a command, which one */
  command?: CommandEntry
  /** Extracted parameters */
  params?: Record<string, unknown>
  /** If routed to chat, the streamed response */
  response?: AsyncIterable<string>
}

// --- Chat panel types ---

export type PanelState = 'minimized' | 'peek' | 'full'

export interface ChatEntry {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  /** If this message triggered a command */
  command?: string
  /** True if this message is an error */
  isError?: boolean
}
