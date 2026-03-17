/**
 * App Manager
 *
 * Manages the lifecycle of Worldscope apps: registration, activation,
 * deactivation. Each app can provide commands, layers, and UI panels.
 */

import type { WorldscopeApp, AppContext, AppResources } from './types'
import { registry } from '@/ai/registry'
import {
  registerLayer, removeLayer, showLayer, hideLayer,
} from '@/features/layers'
import { getViewer } from '@/scene/engine'

interface ActiveApp {
  app: WorldscopeApp
  resources: AppResources
}

const _registered = new Map<string, WorldscopeApp>()
const _active = new Map<string, ActiveApp>()

// ── Tick system for onTick callbacks ──

const _tickCallbacks = new Set<(dt: number) => void>()
let _tickListenerInstalled = false

function installTickListener(): void {
  if (_tickListenerInstalled) return
  _tickListenerInstalled = true

  // Use requestAnimationFrame loop; we pass elapsed seconds
  let lastTime = performance.now()
  function tick() {
    const now = performance.now()
    const dt = (now - lastTime) / 1000
    lastTime = now
    for (const cb of _tickCallbacks) {
      cb(dt)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// ── Context factory ──

function createAppContext(): AppContext {
  return {
    addLayer: registerLayer,
    removeLayer,
    showLayer,
    hideLayer,
    getViewer,
    onTick: (callback: (dt: number) => void) => {
      installTickListener()
      _tickCallbacks.add(callback)
      return () => { _tickCallbacks.delete(callback) }
    },
  }
}

// ── Public API ──

/** Register an app definition (does not activate it). */
export function registerApp(app: WorldscopeApp): void {
  _registered.set(app.id, app)
}

/** Activate a registered app by ID. */
export async function activateApp(id: string): Promise<boolean> {
  if (_active.has(id)) return true // already active

  const app = _registered.get(id)
  if (!app) return false

  const ctx = createAppContext()
  const resources = await app.activate(ctx)

  // Register layers
  for (const layerDef of resources.layers) {
    registerLayer(layerDef)
    if (layerDef.defaultOn) {
      await showLayer(layerDef.id)
    }
  }

  // Register commands
  if (resources.commands.length > 0) {
    registry.registerAll(resources.commands)
  }

  _active.set(id, { app, resources })
  console.log(`[apps] Activated: ${app.name}`)
  return true
}

/** Deactivate an active app by ID. */
export function deactivateApp(id: string): boolean {
  const entry = _active.get(id)
  if (!entry) return false

  const { app, resources } = entry

  // Unregister commands
  registry.unregisterModule(app.id)

  // Remove layers
  for (const layerDef of resources.layers) {
    removeLayer(layerDef.id)
  }

  // Call app cleanup
  app.deactivate?.()

  _active.delete(id)
  console.log(`[apps] Deactivated: ${app.name}`)
  return true
}

/** Activate all apps marked as autoActivate. */
export async function activateAutoApps(): Promise<void> {
  for (const app of _registered.values()) {
    if (app.autoActivate) {
      await activateApp(app.id)
    }
  }
}

/** Get all registered apps with their activation status. */
export function getApps(): Array<{ id: string; name: string; description: string; active: boolean }> {
  const result: Array<{ id: string; name: string; description: string; active: boolean }> = []
  for (const app of _registered.values()) {
    result.push({
      id: app.id,
      name: app.name,
      description: app.description,
      active: _active.has(app.id),
    })
  }
  return result
}
