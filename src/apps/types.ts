/**
 * Worldscope App System types.
 *
 * Apps are self-contained modules that register layers, commands,
 * and optional UI panels. They can be activated/deactivated at runtime.
 */

import type { ComponentType } from 'react'
import type { CommandEntry } from '@/ai/types'
import type { LayerDef } from '@/features/layers/types'
import type * as Cesium from 'cesium'

/** Resources an app provides when activated. */
export interface AppResources {
  /** Commands to register with the AI command registry */
  commands: CommandEntry[]
  /** Data layers to register with the layer manager */
  layers: LayerDef[]
  /** Optional sidebar panel component */
  panel?: ComponentType
}

/** Context provided to an app during activation. */
export interface AppContext {
  addLayer: (def: LayerDef) => void
  removeLayer: (id: string) => void
  showLayer: (id: string) => Promise<boolean>
  hideLayer: (id: string) => boolean
  getViewer: () => Cesium.Viewer | null
  onTick: (callback: (dt: number) => void) => () => void
}

/** A Worldscope app definition. */
export interface WorldscopeApp {
  /** Unique identifier, e.g. 'earthquake', 'weather' */
  id: string
  /** Human-readable name */
  name: string
  /** Short description */
  description: string
  /** If true, activate automatically on startup */
  autoActivate: boolean
  /** Called when the app is activated. Returns resources to register. */
  activate: (ctx: AppContext) => AppResources | Promise<AppResources>
  /** Called when the app is deactivated. Clean up any custom state. */
  deactivate?: () => void
}
