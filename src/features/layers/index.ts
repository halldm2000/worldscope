/**
 * Layers feature: toggleable data overlays on the globe.
 *
 * Registers built-in layers (borders, coastlines, rivers) and chat commands.
 * Layers are lazy-loaded on first toggle, so startup cost is zero.
 */

import { registry } from '@/ai/registry'
import { registerLayer, removeAllLayers, getAllLayers, showLayer } from './manager'
import { BUILTIN_LAYERS } from './sources'
import { layerCommands } from './commands'

let registered = false

export function initLayers(): void {
  if (registered) return

  // Register layer definitions (no network requests yet)
  for (const def of BUILTIN_LAYERS) {
    registerLayer(def)
  }

  // Turn on any layers marked as defaultOn
  for (const def of BUILTIN_LAYERS) {
    if (def.defaultOn) {
      showLayer(def.id)
    }
  }

  // Register chat commands
  registry.registerAll(layerCommands)
  registered = true

  console.log(`[layers] Initialized with ${BUILTIN_LAYERS.length} built-in layers`)
}

export function destroyLayers(): void {
  removeAllLayers()
  registry.unregisterModule('layers')
  registered = false
}

// Re-export for external use
export { registerLayer, getAllLayers, removeLayer } from './manager'
export { showLayer, hideLayer, toggleLayer } from './manager'
