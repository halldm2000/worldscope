/**
 * Core commands that are always available.
 * Navigation, view controls, audio, system.
 */

import * as Cesium from 'cesium'
import type { CommandEntry } from './types'
import { getViewer } from '@/scene/engine'
import { toggleMute, isMuted } from '@/audio/sounds'

// --- Navigation commands ---

const goTo: CommandEntry = {
  id: 'core:go-to',
  name: 'Go to location',
  module: 'core',
  category: 'navigation',
  description: 'Fly the camera to a named location',
  patterns: [
    'go to {place}', 'fly to {place}', 'show me {place}',
    'navigate to {place}', 'take me to {place}', 'zoom to {place}',
  ],
  params: [{ name: 'place', type: 'string', required: true, description: 'Place name or coordinates' }],
  handler: async (params) => {
    const viewer = getViewer()
    if (!viewer) {
      console.warn('[go-to] No viewer available')
      return
    }
    const place = String(params.place).trim()
    console.log('[go-to] Flying to:', place)

    try {
      // Check for raw coordinates like "10, 52" or "10.5 52.3"
      const coordMatch = place.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)(?:[,\s]+(-?\d+\.?\d*))?$/)
      if (coordMatch) {
        const lon = parseFloat(coordMatch[1])
        const lat = parseFloat(coordMatch[2])
        const alt = coordMatch[3] ? parseFloat(coordMatch[3]) : 50_000
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
          duration: 2.0,
        })
        return
      }

      // Named location lookup (common cities, will be extended)
      const location = KNOWN_LOCATIONS[place.toLowerCase()]
      if (location) {
        console.log('[go-to] Found location:', location)
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(location.lon, location.lat, location.height ?? 50_000),
          duration: 2.0,
        })
        return
      }

      console.log('[go-to] Location not in lookup table, trying geocoder...')
      // Fallback: OpenStreetMap Nominatim geocoder (free, no key needed)
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'EarthExplorer/1.0' },
      })
      const data = await resp.json()
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat)
        const lon = parseFloat(data[0].lon)
        // Estimate zoom based on place type
        const type = data[0].type || ''
        let height = 50_000
        if (['continent'].includes(type)) height = 5_000_000
        else if (['country', 'state'].includes(type)) height = 500_000
        else if (['county', 'region'].includes(type)) height = 200_000
        else if (['city', 'town', 'village'].includes(type)) height = 30_000
        else if (['suburb', 'neighbourhood'].includes(type)) height = 5_000
        else if (['building', 'house'].includes(type)) height = 1_000

        console.log(`[go-to] Geocoder found: ${data[0].display_name} (${lat}, ${lon}, type: ${type})`)
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
          duration: 2.0,
        })
      } else {
        console.warn('[go-to] No geocoder results for:', place)
      }
    } catch (err) {
      console.error('[go-to] Error:', err)
    }
  },
}

const resetView: CommandEntry = {
  id: 'core:reset-view',
  name: 'Reset view',
  module: 'core',
  category: 'navigation',
  description: 'Reset the camera to the default home view',
  patterns: ['reset view', 'reset', 'home', 'go home', 'default view'],
  params: [],
  handler: () => {
    const viewer = getViewer()
    if (!viewer) return
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(10, 30, 15_000_000),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
      duration: 2.0,
    })
  },
}

const zoomIn: CommandEntry = {
  id: 'core:zoom-in',
  name: 'Zoom in',
  module: 'core',
  category: 'navigation',
  description: 'Zoom the camera closer to the surface',
  patterns: ['zoom in', 'closer', 'get closer'],
  params: [],
  handler: () => {
    const viewer = getViewer()
    if (!viewer) return
    const pos = viewer.camera.positionCartographic
    const newHeight = Math.max(pos.height * 0.4, 100) // don't go below 100m
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(pos.longitude, pos.latitude, newHeight),
      orientation: {
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: 0,
      },
      duration: 1.5,
    })
  },
}

const zoomOut: CommandEntry = {
  id: 'core:zoom-out',
  name: 'Zoom out',
  module: 'core',
  category: 'navigation',
  description: 'Zoom the camera away from the surface',
  patterns: ['zoom out', 'further', 'pull back', 'back up'],
  params: [],
  handler: () => {
    const viewer = getViewer()
    if (!viewer) return
    const pos = viewer.camera.positionCartographic
    const newHeight = Math.min(pos.height * 2.5, 30_000_000) // don't go past orbit
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(pos.longitude, pos.latitude, newHeight),
      orientation: {
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: 0,
      },
      duration: 1.5,
    })
  },
}

const faceNorth: CommandEntry = {
  id: 'core:face-north',
  name: 'Face north',
  module: 'core',
  category: 'navigation',
  description: 'Rotate the camera to face north',
  patterns: ['face north', 'north up', 'orient north'],
  params: [],
  handler: () => {
    const viewer = getViewer()
    if (!viewer) return
    const pos = viewer.camera.positionCartographic
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(pos.longitude, pos.latitude, pos.height),
      orientation: { heading: 0, pitch: viewer.camera.pitch, roll: 0 },
      duration: 1.0,
    })
  },
}

// --- View commands ---

const toggleBuildings: CommandEntry = {
  id: 'core:toggle-buildings',
  name: 'Toggle buildings',
  module: 'core',
  category: 'view',
  description: 'Show or hide 3D buildings',
  patterns: ['toggle buildings', 'show buildings', 'hide buildings', 'buildings on', 'buildings off'],
  params: [],
  handler: () => {
    const viewer = getViewer()
    if (!viewer) return
    const prims = viewer.scene.primitives
    for (let i = 0; i < prims.length; i++) {
      const p = prims.get(i)
      if (p instanceof Cesium.Cesium3DTileset) {
        p.show = !p.show
      }
    }
  },
}

const toggleTerrain: CommandEntry = {
  id: 'core:toggle-terrain',
  name: 'Toggle terrain',
  module: 'core',
  category: 'view',
  description: 'Switch between 3D terrain and flat surface',
  patterns: ['toggle terrain', 'flat earth', 'show terrain', 'hide terrain'],
  params: [],
  handler: () => {
    const viewer = getViewer()
    if (!viewer) return
    const globe = viewer.scene.globe
    if (globe.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) {
      // Re-enable terrain
      Cesium.CesiumTerrainProvider.fromIonAssetId(1).then(tp => {
        globe.terrainProvider = tp
      })
    } else {
      globe.terrainProvider = new Cesium.EllipsoidTerrainProvider()
    }
  },
}

const toggleLighting: CommandEntry = {
  id: 'core:toggle-lighting',
  name: 'Toggle lighting',
  module: 'core',
  category: 'view',
  description: 'Toggle day/night lighting on the globe',
  patterns: ['toggle lighting', 'toggle sun', 'day night', 'lighting on', 'lighting off'],
  params: [],
  handler: () => {
    const viewer = getViewer()
    if (!viewer) return
    viewer.scene.globe.enableLighting = !viewer.scene.globe.enableLighting
  },
}

const setTimeOfDay: CommandEntry = {
  id: 'core:set-time',
  name: 'Set time of day',
  module: 'core',
  category: 'view',
  description: 'Set the simulated time of day',
  patterns: ['time {time}', 'set time to {time}', 'time of day {time}'],
  params: [{ name: 'time', type: 'string', required: true, description: 'Time like "3pm", "15:00", "noon", "midnight"' }],
  handler: (params) => {
    const viewer = getViewer()
    if (!viewer) return
    const timeStr = String(params.time).toLowerCase().trim()

    let hours = 12
    if (timeStr === 'noon') hours = 12
    else if (timeStr === 'midnight') hours = 0
    else if (timeStr === 'sunrise' || timeStr === 'dawn') hours = 6
    else if (timeStr === 'sunset' || timeStr === 'dusk') hours = 18
    else {
      const match = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
      if (match) {
        hours = parseInt(match[1])
        if (match[3] === 'pm' && hours < 12) hours += 12
        if (match[3] === 'am' && hours === 12) hours = 0
      }
    }

    const now = new Date()
    now.setUTCHours(hours, 0, 0, 0)
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(now)
  },
}

// --- System commands ---

const whatCanYouDo: CommandEntry = {
  id: 'core:help',
  name: 'Help',
  module: 'core',
  category: 'system',
  description: 'List available commands and features',
  patterns: ['help', 'what can you do', 'commands', 'list commands', '?'],
  params: [],
  // Handler returns help text; the router detects this command and shows the output
  handler: () => {
    // Import registry lazily to avoid circular dependency
    const { registry } = require('./registry')
    const cmds = registry.getAll() as CommandEntry[]
    const categories: Record<string, CommandEntry[]> = {}
    for (const cmd of cmds) {
      const cat = cmd.category || 'other'
      if (!categories[cat]) categories[cat] = []
      categories[cat].push(cmd)
    }
    const lines: string[] = ['Available commands:\n']
    const catLabels: Record<string, string> = {
      navigation: 'Navigation',
      view: 'View',
      audio: 'Audio',
      system: 'System',
      feature: 'Features',
      other: 'Other',
    }
    for (const [cat, label] of Object.entries(catLabels)) {
      if (!categories[cat]) continue
      lines.push(`${label}:`)
      for (const cmd of categories[cat]) {
        const example = cmd.patterns[0] || cmd.name.toLowerCase()
        lines.push(`  "${example}" — ${cmd.description}`)
      }
      lines.push('')
    }
    lines.push('Keyboard: Tab or / to focus, ` to cycle panel, Esc to minimize')
    lines.push('Navigation: WASD/arrows to move, Q/E to twist, Shift/Space altitude')
    // Store for the router to pick up
    ;(whatCanYouDo as any)._lastOutput = lines.join('\n')
  },
}

const muteToggle: CommandEntry = {
  id: 'core:mute',
  name: 'Toggle mute',
  module: 'core',
  category: 'audio',
  description: 'Mute or unmute all sounds',
  patterns: ['mute', 'unmute', 'toggle mute', 'sound off', 'sound on'],
  params: [],
  handler: () => {
    const nowMuted = toggleMute()
    console.log('[audio]', nowMuted ? 'Muted' : 'Unmuted')
  },
}

const fullscreen: CommandEntry = {
  id: 'core:fullscreen',
  name: 'Toggle fullscreen',
  module: 'core',
  category: 'system',
  description: 'Toggle browser fullscreen mode',
  patterns: ['fullscreen', 'full screen', 'toggle fullscreen'],
  params: [],
  handler: () => {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      document.documentElement.requestFullscreen()
    }
  },
}

const setApiKey: CommandEntry = {
  id: 'core:set-key',
  name: 'Set API key',
  module: 'core',
  category: 'system',
  description: 'Set the Anthropic API key for AI chat',
  patterns: ['set key {key}', 'set api key {key}', 'anthropic key {key}'],
  params: [{ name: 'key', type: 'string', required: true, description: 'Anthropic API key' }],
  handler: (params) => {
    const key = String(params.key).trim()
    if (!key.startsWith('sk-')) {
      console.warn('[set-key] Invalid key format (should start with sk-)')
      return
    }
    localStorage.setItem('ee-anthropic-key', key)
    // Hot-add the provider
    const { addClaudeProvider } = require('./init')
    addClaudeProvider(key)
  },
}

// --- Known locations (extensible) ---

const KNOWN_LOCATIONS: Record<string, { lat: number; lon: number; height?: number }> = {
  'berlin': { lat: 52.52, lon: 13.405, height: 30_000 },
  'new york': { lat: 40.7128, lon: -74.006, height: 30_000 },
  'nyc': { lat: 40.7128, lon: -74.006, height: 30_000 },
  'london': { lat: 51.5074, lon: -0.1278, height: 30_000 },
  'paris': { lat: 48.8566, lon: 2.3522, height: 30_000 },
  'tokyo': { lat: 35.6762, lon: 139.6503, height: 30_000 },
  'san francisco': { lat: 37.7749, lon: -122.4194, height: 20_000 },
  'sf': { lat: 37.7749, lon: -122.4194, height: 20_000 },
  'boulder': { lat: 40.015, lon: -105.2705, height: 20_000 },
  'mount everest': { lat: 27.9881, lon: 86.925, height: 15_000 },
  'everest': { lat: 27.9881, lon: 86.925, height: 15_000 },
  'grand canyon': { lat: 36.1069, lon: -112.1129, height: 15_000 },
  'sahara': { lat: 23.4162, lon: 25.6628, height: 500_000 },
  'amazon': { lat: -3.4653, lon: -62.2159, height: 200_000 },
  'antarctica': { lat: -82.8628, lon: 135.0, height: 2_000_000 },
  'arctic': { lat: 90, lon: 0, height: 2_000_000 },
  'himalaya': { lat: 28.5983, lon: 83.9311, height: 200_000 },
  'himalayas': { lat: 28.5983, lon: 83.9311, height: 200_000 },
  'alps': { lat: 46.8, lon: 10.5, height: 100_000 },
  'hawaii': { lat: 20.7984, lon: -156.3319, height: 100_000 },
  'iceland': { lat: 64.9631, lon: -19.0208, height: 200_000 },
  'sydney': { lat: -33.8688, lon: 151.2093, height: 30_000 },
  'mumbai': { lat: 19.076, lon: 72.8777, height: 30_000 },
  'beijing': { lat: 39.9042, lon: 116.4074, height: 30_000 },
  'rio': { lat: -22.9068, lon: -43.1729, height: 30_000 },
  'cape town': { lat: -33.9249, lon: 18.4241, height: 30_000 },
  'singapore': { lat: 1.3521, lon: 103.8198, height: 20_000 },
  'dubai': { lat: 25.2048, lon: 55.2708, height: 20_000 },
  'los angeles': { lat: 34.0522, lon: -118.2437, height: 30_000 },
  'la': { lat: 34.0522, lon: -118.2437, height: 30_000 },
  'chicago': { lat: 41.8781, lon: -87.6298, height: 30_000 },
  'washington dc': { lat: 38.9072, lon: -77.0369, height: 30_000 },
  'dc': { lat: 38.9072, lon: -77.0369, height: 30_000 },
  'seattle': { lat: 47.6062, lon: -122.3321, height: 30_000 },
  'denver': { lat: 39.7392, lon: -104.9903, height: 30_000 },
}

/** All core commands */
export const coreCommands: CommandEntry[] = [
  goTo, resetView, zoomIn, zoomOut, faceNorth,
  toggleBuildings, toggleTerrain, toggleLighting, setTimeOfDay,
  muteToggle, whatCanYouDo, fullscreen, setApiKey,
]
