/**
 * Worldscope Plugin API
 *
 * This is the stable contract between the core runtime and external plugins.
 * Plugins interact with the globe exclusively through this interface.
 *
 * Versioned: plugins declare the minimum API version they require.
 * The core supports the current version and one prior major version.
 */

import type * as Cesium from 'cesium'
import type { CommandEntry } from '@/ai/types'
import type { LayerDef } from '@/features/layers/types'
import type { BaseMapStyle } from '@/scene/engine'

// ── Plugin manifest ──

export interface EarthPlugin {
  /** Unique identifier (e.g. 'stormcast-twin', 'earthquake-monitor') */
  id: string
  /** Display name */
  name: string
  /** Semver version of the plugin itself */
  version: string
  /** Minimum API version required (e.g. '1.0') */
  apiVersion: string
  /** Short description */
  description?: string
  /** Plugin author / organization */
  author?: string

  /** Called once when the plugin is loaded. Register layers, commands, panels. */
  setup(api: ExplorerAPI): void | Promise<void>

  /** Called when the plugin is unloaded. Clean up resources. */
  teardown?(): void
}

// ── Data source contract (for weather, model outputs, etc.) ──

export interface GriddedDataSource {
  /** Unique id for this source */
  id: string
  /** Display name */
  name: string
  /** What variables this source provides */
  variables: VariableDef[]
  /** Time capabilities */
  time: TimeCapability
  /** Fetch a grid of values for a given variable, bounds, and time */
  fetch(request: GridRequest): Promise<GridResponse>
}

export interface VariableDef {
  id: string
  name: string
  unit: string
  /** Suggested colormap id (plugins can register custom colormaps) */
  colormap?: string
  /** Value range hint for the colormap [min, max] */
  range?: [number, number]
}

export interface TimeCapability {
  mode: 'realtime' | 'forecast' | 'historical' | 'static'
  /** For forecasts: available lead times in hours */
  steps?: number[]
  /** For historical: available date range */
  range?: { start: string; end: string }
}

export interface GridRequest {
  variable: string
  /** Geographic bounds (degrees) */
  bounds: { west: number; south: number; east: number; north: number }
  /** ISO timestamp or forecast step */
  time?: string | number
  /** Desired resolution hint (degrees per pixel) */
  resolution?: number
}

export interface GridResponse {
  lats: Float64Array | number[]
  lons: Float64Array | number[]
  values: Float32Array | number[]
  unit: string
  /** Timestamp of the data */
  timestamp?: string
  /** For forecasts: which step this represents */
  step?: number
}

// ── Point / track data (earthquakes, ships, flights, etc.) ──

export interface PointDataSource {
  id: string
  name: string
  /** Fetch points within bounds and time range */
  fetch(request: PointRequest): Promise<PointResponse>
  /** If true, the core will poll this source at the given interval */
  realtime?: { intervalMs: number }
}

export interface PointRequest {
  bounds: { west: number; south: number; east: number; north: number }
  timeRange?: { start: string; end: string }
}

export interface PointResponse {
  points: DataPoint[]
}

export interface DataPoint {
  lat: number
  lon: number
  alt?: number
  time?: string
  properties: Record<string, unknown>
  /** How to render: size, color can be data-driven */
  style?: {
    color?: string
    size?: number
    icon?: string
    label?: string
  }
}

// ── Track data (trajectories, hurricane paths, etc.) ──

export interface TrackDataSource {
  id: string
  name: string
  fetch(request: PointRequest): Promise<TrackResponse>
}

export interface TrackResponse {
  tracks: Track[]
}

export interface Track {
  id: string
  name?: string
  points: { lat: number; lon: number; alt?: number; time?: string; properties?: Record<string, unknown> }[]
  style?: {
    color?: string
    width?: number
    dashed?: boolean
  }
}

// ── UI panel contract ──

export interface PanelDef {
  id: string
  name: string
  /** Where the panel appears */
  position: 'left' | 'right' | 'bottom'
  /** Icon name (from lucide or a URL) */
  icon?: string
  /** The panel renders into this container. Receives the API for interactivity. */
  render(container: HTMLElement, api: ExplorerAPI): void | (() => void)
}

// ── Colormap contract ──

export interface ColormapDef {
  id: string
  name: string
  /** Array of [position, r, g, b] where position is 0-1 */
  stops: [number, number, number, number][]
}

// ── The API object handed to plugins ──

export interface ExplorerAPI {
  /** API version string (e.g. '1.0') */
  readonly version: string

  /** Layer management */
  layers: {
    register(def: LayerDef): void
    show(id: string): Promise<boolean>
    hide(id: string): boolean
    toggle(id: string): Promise<boolean>
    getAll(): { id: string; name: string; visible: boolean; category: string }[]
  }

  /** Command registration */
  commands: {
    register(cmd: CommandEntry): void
    registerAll(cmds: CommandEntry[]): void
    unregisterModule(module: string): void
  }

  /** Camera and navigation */
  camera: {
    flyTo(lon: number, lat: number, height: number, duration?: number): void
    getPosition(): { lon: number; lat: number; height: number; heading: number }
    onMove(callback: (position: { lon: number; lat: number; height: number }) => void): () => void
  }

  /** Base map control */
  baseMaps: {
    set(style: BaseMapStyle): Promise<boolean>
    getCurrent(): BaseMapStyle
    getAvailable(): { id: string; name: string; description: string }[]
  }

  /** Data visualization toolkit */
  viz: {
    registerColormap(def: ColormapDef): void
    registerGridSource(source: GriddedDataSource): void
    registerPointSource(source: PointDataSource): void
    registerTrackSource(source: TrackDataSource): void
  }

  /** UI extension */
  ui: {
    addPanel(def: PanelDef): void
    removePanel(id: string): void
    showStatus(text: string): void
    addChatMessage(role: 'assistant', content: string): void
  }

  /**
   * Escape hatch: direct access to the Cesium viewer.
   * Use for custom rendering that the stable API doesn't cover.
   * WARNING: code using this may break if the rendering engine changes.
   */
  unsafe: {
    getCesiumViewer(): Cesium.Viewer | null
  }
}
