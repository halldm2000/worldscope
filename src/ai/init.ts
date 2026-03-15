/**
 * AI system initialization.
 * Registers core commands, feature modules, and AI providers.
 */

import { registry } from './registry'
import { registerProvider, removeProvider } from './router'
import { coreCommands } from './core-commands'
import { ClaudeProvider } from './providers/claude'
import { OpenAIProvider, createOpenAIProvider, createOllamaProvider, createOpenRouterProvider } from './providers/openai'
import { initLayers } from '@/features/layers'

let commandsRegistered = false

export function initAI(options?: { anthropicKey?: string | null }): void {
  // Register core commands once
  if (!commandsRegistered) {
    registry.registerAll(coreCommands)
    commandsRegistered = true

    // Initialize feature modules
    initLayers()
  }

  // Auto-add provider from env / stored key
  if (options?.anthropicKey) {
    addProvider('anthropic', options.anthropicKey)
  }

  console.log(`[AI] Initialized with ${registry.getAll().length} commands`)
}

/**
 * Add or replace an AI provider by type.
 * Called from the "set provider" command or at init time.
 */
export function addProvider(
  type: 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'custom',
  apiKey: string,
  options?: { model?: string; baseUrl?: string },
): void {
  let provider

  switch (type) {
    case 'anthropic':
      provider = new ClaudeProvider(apiKey)
      break
    case 'openai':
      provider = createOpenAIProvider(apiKey, options?.model)
      break
    case 'ollama':
      provider = createOllamaProvider(options?.model, options?.baseUrl)
      break
    case 'openrouter':
      provider = createOpenRouterProvider(apiKey, options?.model)
      break
    case 'custom':
      provider = new OpenAIProvider({
        name: 'custom',
        baseUrl: options?.baseUrl || 'http://localhost:8000/v1',
        apiKey,
        defaultModel: options?.model || 'default',
      })
      break
  }

  registerProvider(provider)
  console.log(`[AI] Provider added: ${provider.name}`)
}

// Re-export for use by the set-provider command
export { removeProvider }
