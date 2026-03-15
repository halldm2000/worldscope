/**
 * Anthropic (Claude) AI Provider
 *
 * Implements streaming chat with tool use via the Messages API.
 * Translates between the normalized StreamEvent format and
 * Anthropic's native content_block / tool_use wire format.
 */

import type { AIProvider, ChatMessage, ChatOptions, ToolDef, StreamEvent, ContentBlock } from '../types'
import { parseAPIError, parseNetworkError } from '../errors'

export class ClaudeProvider implements AIProvider {
  readonly name = 'claude'
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async available(): Promise<boolean> {
    return !!this.apiKey && navigator.onLine
  }

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDef[],
    options?: ChatOptions,
  ): AsyncIterable<StreamEvent> {
    // Convert to Anthropic message format
    const apiMessages = this.convertMessages(messages)

    const body: Record<string, unknown> = {
      model: options?.model || 'claude-sonnet-4-20250514',
      max_tokens: options?.maxTokens || 2048,
      stream: true,
      messages: apiMessages,
    }

    if (options?.systemPrompt) {
      body.system = options.systemPrompt
    }

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature
    }

    // Convert tool definitions to Anthropic format
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }

    let response: Response
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      const parsed = parseNetworkError(err, 'Anthropic')
      yield { type: 'error', message: parsed.message }
      yield { type: 'done' }
      return
    }

    if (!response.ok) {
      const body = await response.text()
      const parsed = parseAPIError(response.status, body, 'Anthropic')
      yield { type: 'error', message: parsed.message }
      yield { type: 'done' }
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      yield { type: 'error', message: 'No response stream from Anthropic.' }
      yield { type: 'done' }
      return
    }

    // Parse SSE stream, tracking tool use state
    const decoder = new TextDecoder()
    let buffer = ''
    let currentToolId = ''
    let currentToolName = ''
    let toolInputJson = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') {
          yield { type: 'done' }
          return
        }

        try {
          const event = JSON.parse(data)

          // Text content
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            yield { type: 'text', content: event.delta.text }
          }

          // Tool use start
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            currentToolId = event.content_block.id
            currentToolName = event.content_block.name
            toolInputJson = ''
          }

          // Tool use input accumulation
          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
            toolInputJson += event.delta.partial_json
          }

          // Tool use complete
          if (event.type === 'content_block_stop' && currentToolId && currentToolName) {
            let args: Record<string, unknown> = {}
            try {
              if (toolInputJson) args = JSON.parse(toolInputJson)
            } catch {
              // Malformed tool input
            }
            yield {
              type: 'tool_call',
              call: { id: currentToolId, name: currentToolName, arguments: args },
            }
            currentToolId = ''
            currentToolName = ''
            toolInputJson = ''
          }

          // Message complete
          if (event.type === 'message_stop') {
            yield { type: 'done' }
            return
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    yield { type: 'done' }
  }

  /**
   * Convert normalized ChatMessages to Anthropic's message format.
   * Handles tool results and tool calls in the conversation history.
   */
  private convertMessages(messages: ChatMessage[]): unknown[] {
    const result: unknown[] = []

    for (const msg of messages) {
      if (msg.role === 'system') continue // system prompt goes in body.system

      if (msg.role === 'user') {
        // Support rich content blocks (text + images)
        if (Array.isArray(msg.content)) {
          result.push({ role: 'user', content: this.convertContentBlocks(msg.content) })
        } else {
          result.push({ role: 'user', content: msg.content })
        }
      }

      if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          // Assistant message with tool calls
          const content: unknown[] = []
          const textContent = typeof msg.content === 'string' ? msg.content : ''
          if (textContent) {
            content.push({ type: 'text', text: textContent })
          }
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            })
          }
          result.push({ role: 'assistant', content })
        } else {
          result.push({ role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '' })
        }
      }

      if (msg.role === 'tool') {
        // Anthropic expects tool results as user messages with tool_result content.
        // Content can include images (for screenshot tool results).
        const toolContent = Array.isArray(msg.content)
          ? this.convertContentBlocks(msg.content)
          : msg.content

        result.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.toolCallId,
            content: toolContent,
          }],
        })
      }
    }

    return result
  }

  /** Convert our ContentBlock[] to Anthropic's content block format. */
  private convertContentBlocks(blocks: ContentBlock[]): unknown[] {
    return blocks.map(block => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text }
      }
      if (block.type === 'image') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: block.mediaType,
            data: block.data,
          },
        }
      }
      return block
    })
  }
}
