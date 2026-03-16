/**
 * API Usage Tracker
 *
 * Tracks token usage and estimates cost across all AI requests.
 * Persists session totals in memory, lifetime totals in localStorage.
 */

import type { UsageData } from './types'

// Per-million-token pricing (as of 2025)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.0 },
  // Fallback for unknown models
  'default': { input: 3.0, output: 15.0 },
}

export interface UsageSnapshot {
  /** Tokens used this session */
  sessionInputTokens: number
  sessionOutputTokens: number
  /** Estimated cost this session in USD */
  sessionCost: number
  /** Number of API requests this session */
  sessionRequests: number
  /** Lifetime totals (persisted in localStorage) */
  lifetimeInputTokens: number
  lifetimeOutputTokens: number
  lifetimeCost: number
  lifetimeRequests: number
}

type UsageListener = (snapshot: UsageSnapshot) => void

class UsageTracker {
  private sessionInput = 0
  private sessionOutput = 0
  private sessionCost = 0
  private sessionRequests = 0
  private listeners: UsageListener[] = []

  /** Record usage from an API response */
  record(usage: UsageData): void {
    const pricing = MODEL_PRICING[usage.model] || MODEL_PRICING['default']
    const cost = (usage.inputTokens / 1_000_000) * pricing.input
               + (usage.outputTokens / 1_000_000) * pricing.output

    this.sessionInput += usage.inputTokens
    this.sessionOutput += usage.outputTokens
    this.sessionCost += cost
    this.sessionRequests++

    // Persist lifetime totals
    const lifetime = this.getLifetime()
    lifetime.inputTokens += usage.inputTokens
    lifetime.outputTokens += usage.outputTokens
    lifetime.cost += cost
    lifetime.requests++
    this.saveLifetime(lifetime)

    console.log(`[usage] +${usage.inputTokens}in/${usage.outputTokens}out (${usage.model}) = $${cost.toFixed(4)}. Session total: $${this.sessionCost.toFixed(4)} (${this.sessionRequests} requests)`)

    // Notify listeners
    const snapshot = this.getSnapshot()
    for (const fn of this.listeners) fn(snapshot)
  }

  /** Get current usage snapshot */
  getSnapshot(): UsageSnapshot {
    const lifetime = this.getLifetime()
    return {
      sessionInputTokens: this.sessionInput,
      sessionOutputTokens: this.sessionOutput,
      sessionCost: this.sessionCost,
      sessionRequests: this.sessionRequests,
      lifetimeInputTokens: lifetime.inputTokens,
      lifetimeOutputTokens: lifetime.outputTokens,
      lifetimeCost: lifetime.cost,
      lifetimeRequests: lifetime.requests,
    }
  }

  /** Subscribe to usage updates. Returns unsubscribe function. */
  subscribe(fn: UsageListener): () => void {
    this.listeners.push(fn)
    return () => { this.listeners = this.listeners.filter(l => l !== fn) }
  }

  private getLifetime(): { inputTokens: number; outputTokens: number; cost: number; requests: number } {
    try {
      const raw = localStorage.getItem('worldscope-usage')
      if (raw) return JSON.parse(raw)
    } catch { /* ignore */ }
    return { inputTokens: 0, outputTokens: 0, cost: 0, requests: 0 }
  }

  private saveLifetime(data: { inputTokens: number; outputTokens: number; cost: number; requests: number }): void {
    try {
      localStorage.setItem('worldscope-usage', JSON.stringify(data))
    } catch { /* ignore */ }
  }
}

export const usageTracker = new UsageTracker()
