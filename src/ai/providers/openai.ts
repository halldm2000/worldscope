/**
 * OpenAI-Compatible AI Provider
 *
 * Works with any API that implements the OpenAI Chat Completions format:
 * OpenAI, Ollama, OpenRouter, Together, Groq, LM Studio, vLLM, etc.
 *
 * Implements streaming chat with function calling (tool use).
 */

import type { AIProvider, ChatMessage, ChatOptions, ToolDef, StreamEvent } from '../types'
import { parseAPIError, parseNetworkError } from '../errors'

export interface OpenAIProviderConfig {
  /** Display name (e.g. 'openai', 'ollama', 'openrouter') */
  name: string
  /** Base URL for the API (e.g. 'https://api.openai.com/v1', 'http://localhost:11434/v1') */
  baseUrl: string
  /** API key (empty string for keyless local APIs like Ollama) */
  apiKey: string
  /** Default model (e.g. 'gpt-4o', 'llama3.1', 'anthropic/claude-3.5-sonnet') */
  defaultModel: string
  /** Extra headers (e.g. OpenRouter's HTTP-Referer) */
  extraHeaders?: Record<string, string>
}

export class OpenAIProvider implements AIProvider {
  readonly name: string
  private config: OpenAIProviderConfig

  constructor(config: OpenAIProviderConfig) {
    this.name = config.name
    this.config = config
  }

  async available(): Promise<boolean> {
    // Local providers (Ollama) don't need online check
    if (this.config.baseUrl.includes('localhost') || this.config.baseUrl.includes('127.0.0.1')) {
      return true
    }
    return !!this.config.apiKey && navigator.onLine
  }

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDef[],
    options?: ChatOptions,
  ): AsyncIterable<StreamEvent> {
    const apiMessages = this.convertMessages(messages, options?.systemPrompt)

    const body: Record<string, unknown> = {
      model: options?.model || this.config.defaultModel,
      max_tokens: options?.maxTokens || 2048,
      stream: true,
      messages: apiMessages,
    }

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature
    }

    // Convert tool definitions to OpenAI function calling format
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.extraHeaders,
    }
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch (err) {
      const parsed = parseNetworkError(err, this.name)
      yield { type: 'error', message: parsed.message }
      yield { type: 'done' }
      return
    }

    if (!response.ok) {
      const errBody = await response.text()
      const parsed = parseAPIError(response.status, errBody, this.name)
      yield { type: 'error', message: parsed.message }
      yield { type: 'done' }
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      yield { type: 'error', message: `No response stream from ${this.name}.` }
      yield { type: 'done' }
      return
    }

    // Parse SSE stream
    const decoder = new TextDecoder()
    let buffer = ''

    // OpenAI streams tool calls as deltas across multiple chunks
    const pendingTools = new Map<number, { id: string; name: string; args: string }>()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          // Flush any pending tool calls
          for (const [, tool] of pendingTools) {
            let args: Record<string, unknown> = {}
            try { if (tool.args) args = JSON.parse(tool.args) } catch {}
            yield { type: 'tool_call', call: { id: tool.id, name: tool.name, arguments: args } }
          }
          pendingTools.clear()
          yield { type: 'done' }
          return
        }

        try {
          const event = JSON.parse(data)
          const delta = event.choices?.[0]?.delta
          const finishReason = event.choices?.[0]?.finish_reason

          if (!delta && !finishReason) continue

          // Text content
          if (delta?.content) {
            yield { type: 'text', content: delta.content }
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!pendingTools.has(idx)) {
                pendingTools.set(idx, {
                  id: tc.id || `call_${idx}_${Date.now()}`,
                  name: tc.function?.name || '',
                  args: '',
                })
              }
              const pending = pendingTools.get(idx)!
              if (tc.id) pending.id = tc.id
              if (tc.function?.name) pending.name = tc.function.name
              if (tc.function?.arguments) pending.args += tc.function.arguments
            }
          }

          // Finish reason: tool_calls means flush and emit
          if (finishReason === 'tool_calls' || finishReason === 'stop') {
            for (const [, tool] of pendingTools) {
              let args: Record<string, unknown> = {}
              try { if (tool.args) args = JSON.parse(tool.args) } catch {}
              yield { type: 'tool_call', call: { id: tool.id, name: tool.name, arguments: args } }
            }
            pendingTools.clear()

            if (finishReason === 'stop') {
              yield { type: 'done' }
              return
            }
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    yield { type: 'done' }
  }

  /**
   * Convert normalized ChatMessages to OpenAI format.
   */
  private convertMessages(messages: ChatMessage[], systemPrompt?: string): unknown[] {
    const result: unknown[] = []

    // System prompt first
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt })
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        result.push({ role: 'system', content: msg.content })
      }

      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content })
      }

      if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          result.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          })
        } else {
          result.push({ role: 'assistant', content: msg.content })
        }
      }

      if (msg.role === 'tool') {
        // OpenAI/Ollama don't support image content in tool results.
        // Extract text only, skip images.
        let toolContent: string
        if (Array.isArray(msg.content)) {
          toolContent = msg.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map(b => b.text)
            .join('\n')
        } else {
          toolContent = msg.content
        }
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: toolContent,
        })
      }
    }

    return result
  }
}

// --- Convenience factories for common providers ---

export function createOpenAIProvider(apiKey: string, model?: string): OpenAIProvider {
  return new OpenAIProvider({
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey,
    defaultModel: model || 'gpt-4o',
  })
}

export function createOllamaProvider(model?: string, baseUrl?: string): OpenAIProvider {
  return new OpenAIProvider({
    name: 'ollama',
    baseUrl: baseUrl || 'http://localhost:11434/v1',
    apiKey: '',
    defaultModel: model || 'llama3.1',
  })
}

export function createOpenRouterProvider(apiKey: string, model?: string): OpenAIProvider {
  return new OpenAIProvider({
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    defaultModel: model || 'anthropic/claude-sonnet-4-20250514',
    extraHeaders: {
      'HTTP-Referer': 'https://worldscope.dev',
      'X-Title': 'Worldscope',
    },
  })
}
