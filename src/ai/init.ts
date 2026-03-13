/**
 * AI system initialization.
 * Registers core commands and sets up providers.
 */

import { registry } from './registry'
import { registerProvider, removeProvider } from './router'
import { coreCommands } from './core-commands'
import { ClaudeProvider } from './providers/claude'

let commandsRegistered = false
let claudeAdded = false

export function initAI(options?: { anthropicKey?: string | null }): void {
  // Register core commands once
  if (!commandsRegistered) {
    registry.registerAll(coreCommands)
    commandsRegistered = true
  }

  // Add Claude provider if key is available and we haven't already
  if (options?.anthropicKey && !claudeAdded) {
    registerProvider(new ClaudeProvider(options.anthropicKey))
    claudeAdded = true
    console.log(`[AI] Initialized with ${registry.getAll().length} commands, Claude provider active`)
  } else if (!claudeAdded) {
    console.log(`[AI] Initialized with ${registry.getAll().length} commands, no cloud provider`)
  }
}

/**
 * Hot-add a Claude provider (e.g. after user enters API key via command).
 */
export function addClaudeProvider(apiKey: string): void {
  if (claudeAdded) {
    removeProvider('claude')
  }
  registerProvider(new ClaudeProvider(apiKey))
  claudeAdded = true
  console.log('[AI] Claude provider added')
}
