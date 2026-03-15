/**
 * Query commands: read-only tools that return information about the current
 * viewer state. These let the AI inspect the scene, check what's visible,
 * and answer questions about what the user is looking at.
 *
 * Unlike action commands (go-to, toggle-layer), these don't change anything.
 * They're tools the AI calls when it needs data before deciding what to do,
 * or when the user asks "what am I looking at?" / "where am I?"
 */

import * as Cesium from 'cesium'
import type { CommandEntry, ContentBlock } from './types'
import { getViewer, getBaseMapStyle, getBuildingMode } from '@/scene/engine'
import { getAllLayers } from '@/features/layers/manager'

// --- Camera / position query ---

const queryCamera: CommandEntry = {
  id: 'query:camera',
  name: 'Query camera',
  module: 'query',
  category: 'system',
  description: 'Get the current camera position, altitude, heading, and pitch. Use this to answer "where am I?" or before making relative adjustments.',
  patterns: ['where am i', 'current position', 'what altitude'],
  params: [],
  aiHidden: false,
  handler: () => {
    const viewer = getViewer()
    if (!viewer) return 'Viewer not initialized'

    const pos = viewer.camera.positionCartographic
    const lat = Cesium.Math.toDegrees(pos.latitude)
    const lon = Cesium.Math.toDegrees(pos.longitude)
    const altM = pos.height
    const heading = Cesium.Math.toDegrees(viewer.camera.heading)
    const pitch = Cesium.Math.toDegrees(viewer.camera.pitch)

    const altStr = altM > 1000
      ? `${(altM / 1000).toFixed(1)} km`
      : `${Math.round(altM)} m`

    return [
      `Position: ${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E`,
      `Altitude: ${altStr} (${Math.round(altM)} meters)`,
      `Heading: ${heading.toFixed(0)}° (${compassDirection(heading)})`,
      `Pitch: ${pitch.toFixed(0)}°`,
    ].join('\n')
  },
}

// --- Layers query ---

const queryLayers: CommandEntry = {
  id: 'query:layers',
  name: 'Query layers',
  module: 'query',
  category: 'system',
  description: 'List all available data layers and their current on/off status.',
  patterns: ['list layers', 'what layers', 'which layers are on'],
  params: [],
  aiHidden: false,
  handler: () => {
    const layers = getAllLayers()
    if (layers.length === 0) return 'No layers registered.'

    const lines = layers.map(l => {
      const status = l.visible ? 'ON' : 'off'
      return `[${status}] ${l.def.name} (${l.def.id}) — ${l.def.description || l.def.category || 'no description'}`
    })
    return `${layers.length} layers available:\n${lines.join('\n')}`
  },
}

// --- Scene state query (comprehensive) ---

const queryScene: CommandEntry = {
  id: 'query:scene',
  name: 'Query scene',
  module: 'query',
  category: 'system',
  description: 'Get a full snapshot of the current scene state: camera, layers, base map, buildings, lighting. Use this for comprehensive situational awareness.',
  patterns: ['scene status', 'what is showing'],
  params: [],
  aiHidden: false,
  handler: () => {
    const viewer = getViewer()
    if (!viewer) return 'Viewer not initialized'

    const pos = viewer.camera.positionCartographic
    const lat = Cesium.Math.toDegrees(pos.latitude).toFixed(4)
    const lon = Cesium.Math.toDegrees(pos.longitude).toFixed(4)
    const altM = pos.height
    const altStr = altM > 1000
      ? `${(altM / 1000).toFixed(1)} km`
      : `${Math.round(altM)} m`

    const baseMap = getBaseMapStyle()
    const buildings = getBuildingMode()
    const terrain = viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider ? 'flat' : 'terrain'
    const lighting = viewer.scene.globe.enableLighting ? 'on' : 'off'

    const layers = getAllLayers()
    const active = layers.filter(l => l.visible).map(l => l.def.name)
    const inactive = layers.filter(l => !l.visible).map(l => l.def.name)

    return [
      `Camera: ${lat}°N, ${lon}°E at ${altStr}`,
      `Heading: ${Cesium.Math.toDegrees(viewer.camera.heading).toFixed(0)}°, Pitch: ${Cesium.Math.toDegrees(viewer.camera.pitch).toFixed(0)}°`,
      `Base map: ${baseMap}`,
      `Buildings: ${buildings}`,
      `Terrain: ${terrain}`,
      `Lighting: ${lighting}`,
      `Active layers: ${active.length > 0 ? active.join(', ') : 'none'}`,
      `Inactive layers: ${inactive.length > 0 ? inactive.join(', ') : 'none'}`,
    ].join('\n')
  },
}

// --- Screenshot tool (captures the canvas for AI vision) ---

const queryScreenshot: CommandEntry = {
  id: 'query:screenshot',
  name: 'Take screenshot',
  module: 'query',
  category: 'system',
  description: 'Capture a screenshot of the current 3D view. Returns an image the AI can analyze to answer visual questions like "what am I looking at?", "is that a mountain?", or "describe what you see".',
  patterns: ['screenshot', 'what do you see', 'describe the view'],
  params: [],
  aiHidden: false,
  handler: async (): Promise<ContentBlock[]> => {
    const viewer = getViewer()
    if (!viewer) return [{ type: 'text', text: 'Viewer not initialized' }]

    // Force a render so the canvas has the latest frame
    viewer.scene.render()

    const canvas = viewer.scene.canvas
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7) // JPEG at 70% quality for size
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '')

    // Get position context to help the AI interpret the image
    const pos = viewer.camera.positionCartographic
    const lat = Cesium.Math.toDegrees(pos.latitude).toFixed(2)
    const lon = Cesium.Math.toDegrees(pos.longitude).toFixed(2)
    const altM = pos.height
    const altStr = altM > 1000
      ? `${(altM / 1000).toFixed(1)} km`
      : `${Math.round(altM)} m`

    return [
      { type: 'text', text: `Screenshot captured. Camera at ${lat}°N, ${lon}°E, altitude ${altStr}. Canvas size: ${canvas.width}x${canvas.height}px.` },
      { type: 'image', mediaType: 'image/jpeg', data: base64 },
    ]
  },
}

// --- Point query (what's at a specific location) ---

const queryPoint: CommandEntry = {
  id: 'query:elevation',
  name: 'Query elevation',
  module: 'query',
  category: 'data',
  description: 'Get the terrain elevation at a specific latitude/longitude. Useful for answering "how high is this mountain?" or "what\'s the elevation here?".',
  patterns: ['elevation at {lat} {lon}', 'how high is'],
  params: [
    { name: 'lat', type: 'number', required: true, description: 'Latitude in degrees' },
    { name: 'lon', type: 'number', required: true, description: 'Longitude in degrees' },
  ],
  aiHidden: false,
  handler: async (params) => {
    const viewer = getViewer()
    if (!viewer) return 'Viewer not initialized'

    const lat = typeof params.lat === 'number' ? params.lat : parseFloat(String(params.lat))
    const lon = typeof params.lon === 'number' ? params.lon : parseFloat(String(params.lon))

    if (isNaN(lat) || isNaN(lon)) return 'Invalid coordinates'

    const positions = [Cesium.Cartographic.fromDegrees(lon, lat)]

    try {
      const updated = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions)
      const elevation = updated[0].height
      return `Terrain elevation at ${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E: ${Math.round(elevation)} meters (${(elevation * 3.281).toFixed(0)} feet)`
    } catch {
      return `Could not sample terrain at ${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E (terrain data may not be available at this location)`
    }
  },
}

// --- Helpers ---

function compassDirection(heading: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = Math.round(((heading % 360) + 360) % 360 / 45) % 8
  return dirs[idx]
}

/** All query commands */
export const queryCommands: CommandEntry[] = [
  queryCamera,
  queryLayers,
  queryScene,
  queryScreenshot,
  queryPoint,
]
