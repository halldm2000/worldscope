/**
 * Core commands that are always available.
 * Navigation, view controls, audio, system.
 */

import * as Cesium from 'cesium'
import type { CommandEntry } from './types'
import {
  getViewer, getBuildingMode, setBuildingMode, setAutoSwitch,
  setBaseMapStyle, getBaseMapStyles, getBaseMapStyle,
  startOrbit, stopOrbit, isOrbiting,
  type BaseMapStyle,
} from '@/scene/engine'
import { toggleMute, isMuted, playRumble } from '@/audio/sounds'

// --- Helpers ---

/**
 * Awaitable flyTo: wraps Cesium's camera.flyTo in a Promise that resolves
 * when the animation completes. This ensures tool handlers don't return
 * before the camera has actually arrived, preventing race conditions when
 * chaining navigation commands (e.g. go-to followed by look-at).
 */
function flyToAsync(
  camera: Cesium.Camera,
  options: Parameters<Cesium.Camera['flyTo']>[0],
): Promise<void> {
  stopOrbit()
  return new Promise((resolve) => {
    camera.flyTo({
      ...options,
      complete: () => resolve(),
      cancel: () => resolve(), // resolve even if cancelled (e.g. by another flyTo)
    })
  })
}

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
    playRumble()

    try {
      // Check for raw coordinates like "10, 52" or "10.5 52.3"
      const coordMatch = place.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)(?:[,\s]+(-?\d+\.?\d*))?$/)
      if (coordMatch) {
        const lon = parseFloat(coordMatch[1])
        const lat = parseFloat(coordMatch[2])
        const alt = coordMatch[3] ? parseFloat(coordMatch[3]) : 50_000
        await flyToAsync(viewer.camera, {
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
          duration: 2.0,
        })
        return `Flying to coordinates (${lon}, ${lat})`
      }

      // Named location lookup (common cities, will be extended)
      const location = KNOWN_LOCATIONS[place.toLowerCase()]
      if (location) {
        console.log('[go-to] Found location:', location)
        await flyToAsync(viewer.camera, {
          destination: Cesium.Cartesian3.fromDegrees(location.lon, location.lat, location.height ?? 50_000),
          duration: 2.0,
        })
        return `Flying to ${place} (${location.lat}, ${location.lon})`
      }

      console.log('[go-to] Location not in lookup table, trying geocoder...')
      // Fallback: OpenStreetMap Nominatim geocoder (free, no key needed)
      // Request multiple results so we can pick the best one (not just the first)
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=5&addressdetails=1`
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'EarthExplorer/1.0' },
      })
      const data = await resp.json()
      if (data && data.length > 0) {
        // Rank results: prefer landmarks, buildings, and populated places over
        // natural features like peaks or ridges. This avoids "Big Ben" resolving
        // to an Australian mountain instead of the London clock tower.
        const preferredTypes = [
          'attraction', 'tourism', 'monument', 'memorial', 'tower', 'clock',
          'building', 'house', 'place_of_worship', 'castle', 'museum',
          'city', 'town', 'village', 'suburb', 'neighbourhood',
          'administrative', 'county', 'region', 'country', 'state', 'continent',
        ]
        const ranked = [...data].sort((a, b) => {
          const typeA = a.type || ''
          const typeB = b.type || ''
          const classA = a.class || ''
          const classB = b.class || ''
          // Strongly prefer tourism/historic/building classes
          const boostClasses = ['tourism', 'historic', 'building', 'amenity', 'place']
          const boostA = boostClasses.includes(classA) ? -100 : 0
          const boostB = boostClasses.includes(classB) ? -100 : 0
          const idxA = preferredTypes.indexOf(typeA)
          const idxB = preferredTypes.indexOf(typeB)
          const scoreA = (idxA >= 0 ? idxA : 50) + boostA
          const scoreB = (idxB >= 0 ? idxB : 50) + boostB
          return scoreA - scoreB
        })

        const best = ranked[0]
        const lat = parseFloat(best.lat)
        const lon = parseFloat(best.lon)
        const type = best.type || ''
        const cls = best.class || ''
        let height = 50_000
        if (['continent'].includes(type)) height = 5_000_000
        else if (['country', 'state'].includes(type)) height = 500_000
        else if (['county', 'region'].includes(type)) height = 200_000
        else if (['city', 'town', 'village'].includes(type)) height = 30_000
        else if (['suburb', 'neighbourhood'].includes(type)) height = 5_000
        else if (['building', 'house', 'attraction', 'tower', 'monument', 'clock'].includes(type)
                 || ['tourism', 'historic', 'building'].includes(cls)) height = 1_000

        if (data.length > 1) {
          console.log(`[go-to] Geocoder returned ${data.length} results, ranked best: ${best.display_name} (class: ${cls}, type: ${type})`)
          console.log(`[go-to] Other candidates:`, data.slice(0, 4).map((d: any) => `${d.display_name} (${d.class}/${d.type})`))
        }
        console.log(`[go-to] Geocoder found: ${best.display_name} (${lat}, ${lon}, type: ${type})`)
        await flyToAsync(viewer.camera, {
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
          duration: 2.0,
        })
        return `Flying to ${best.display_name} (${lat}, ${lon})`
      } else {
        return `Could not find location: ${place}`
      }
    } catch (err) {
      console.error('[go-to] Error:', err)
      return `Error navigating to ${place}`
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
  handler: async () => {
    const viewer = getViewer()
    if (!viewer) return
    playRumble()
    await flyToAsync(viewer.camera, {
      destination: Cesium.Cartesian3.fromDegrees(10, 30, 25_000_000),
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
  description: 'Zoom in one step (reduces altitude by ~60%). Only for small incremental adjustments. For large jumps or specific altitudes, use core:zoom-to instead.',
  patterns: ['zoom in', 'closer', 'get closer'],
  params: [],
  handler: async () => {
    const viewer = getViewer()
    if (!viewer) return 'No viewer available'
    playRumble()
    const pos = viewer.camera.positionCartographic
    const newHeight = Math.max(pos.height * 0.4, 100) // don't go below 100m
    await flyToAsync(viewer.camera, {
      destination: Cesium.Cartesian3.fromRadians(pos.longitude, pos.latitude, newHeight),
      orientation: {
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: 0,
      },
      duration: 1.5,
    })
    return `Zooming in to ${Math.round(newHeight / 1000)} km`
  },
}

const zoomOut: CommandEntry = {
  id: 'core:zoom-out',
  name: 'Zoom out',
  module: 'core',
  category: 'navigation',
  description: 'Zoom out one step (increases altitude by ~2.5x). Only for small incremental adjustments. For large jumps or specific altitudes, use core:zoom-to instead.',
  patterns: ['zoom out', 'further', 'pull back', 'back up'],
  params: [],
  handler: async () => {
    const viewer = getViewer()
    if (!viewer) return 'No viewer available'
    playRumble()
    const pos = viewer.camera.positionCartographic
    const newHeight = Math.min(pos.height * 2.5, 25_000_000) // max 25,000 km
    await flyToAsync(viewer.camera, {
      destination: Cesium.Cartesian3.fromRadians(pos.longitude, pos.latitude, newHeight),
      orientation: {
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: 0,
      },
      duration: 1.5,
    })
    return `Zooming out to ${Math.round(newHeight / 1000)} km`
  },
}

const zoomTo: CommandEntry = {
  id: 'core:zoom-to',
  name: 'Zoom to altitude',
  module: 'core',
  category: 'navigation',
  description: 'Set the camera to a specific altitude in kilometers. PREFERRED for any request involving "close look", "street level", "see details", or large altitude changes. Examples: close look = 0.3, city view = 5, country view = 500, continental = 5000.',
  patterns: ['zoom to {altitude}', 'altitude {altitude}'],
  params: [
    { name: 'altitude', type: 'number', required: true, description: 'Target altitude in kilometers' },
  ],
  handler: async (params) => {
    const viewer = getViewer()
    if (!viewer) return 'No viewer available'
    const altKm = typeof params.altitude === 'number' ? params.altitude : parseFloat(String(params.altitude))
    if (isNaN(altKm) || altKm <= 0) return 'Invalid altitude'
    playRumble()
    const pos = viewer.camera.positionCartographic
    const altAGL = Math.min(Math.max(altKm * 1000, 100), 25_000_000)
    // Get terrain height so altitude is above ground level, not above ellipsoid
    const terrain = viewer.scene.globe.getHeight(pos)
    const terrainHeight = terrain ?? 0
    const altMSL = altAGL + terrainHeight
    await flyToAsync(viewer.camera, {
      destination: Cesium.Cartesian3.fromRadians(pos.longitude, pos.latitude, altMSL),
      orientation: {
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: 0,
      },
      duration: 1.5,
    })
    return `Zooming to ${altKm} km above ground level`
  },
}

const directionHeadings: Record<string, number> = {
  north: 0, south: 180, east: 90, west: 270,
  northeast: 45, northwest: 315, southeast: 135, southwest: 225,
}

const faceDirection: CommandEntry = {
  id: 'core:face',
  name: 'Face direction',
  module: 'core',
  category: 'navigation',
  description: 'Rotate the camera to face a compass direction or numeric heading. Accepts named directions (north, south, east, west, northeast, etc.) or a heading in degrees (0=north, 90=east, 180=south, 270=west).',
  patterns: ['face north', 'north up', 'orient north', 'face south', 'face east', 'face west', 'face northeast', 'face northwest', 'face southeast', 'face southwest', 'heading {heading}'],
  params: [
    { name: 'direction', type: 'string', required: false, description: 'Compass direction: north, south, east, west, northeast, northwest, southeast, southwest' },
    { name: 'heading', type: 'number', required: false, description: 'Heading in degrees (0=north, 90=east, 180=south, 270=west)' },
  ],
  handler: async (params) => {
    const viewer = getViewer()
    if (!viewer) return
    let headingDeg: number
    let label: string
    if (typeof params.heading === 'number') {
      headingDeg = params.heading % 360
      label = `${headingDeg}°`
    } else {
      const dir = (typeof params.direction === 'string' ? params.direction : 'north').toLowerCase()
      headingDeg = directionHeadings[dir] ?? 0
      label = dir
    }
    playRumble()
    const pos = viewer.camera.positionCartographic
    await flyToAsync(viewer.camera, {
      destination: Cesium.Cartesian3.fromRadians(pos.longitude, pos.latitude, pos.height),
      orientation: { heading: Cesium.Math.toRadians(headingDeg), pitch: Cesium.Math.toRadians(-30), roll: 0 },
      duration: 1.0,
    })
    return `Facing ${label}`
  },
}

// --- View commands ---

const toggleBuildings: CommandEntry = {
  id: 'core:toggle-buildings',
  name: 'Toggle buildings',
  module: 'core',
  category: 'view',
  description: 'Switch between photorealistic and OSM buildings',
  patterns: [
    'toggle buildings', 'switch buildings',
    'photorealistic', 'photorealistic buildings', 'google buildings',
    'osm buildings', 'simple buildings', 'white buildings',
    'show buildings', 'hide buildings', 'buildings on', 'buildings off',
  ],
  params: [],
  handler: () => {
    setAutoSwitch(false) // manual override disables auto-switching
    const current = getBuildingMode()
    setBuildingMode(current === 'osm' ? 'photorealistic' : 'osm')
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
  handler: async () => {
    const viewer = getViewer()
    if (!viewer) return
    const globe = viewer.scene.globe

    // Photorealistic 3D tiles have baked-in terrain mesh — must switch to OSM to flatten
    if (getBuildingMode() === 'photorealistic') {
      setBuildingMode('osm')
      setAutoSwitch(false)
    }

    if (globe.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) {
      // Re-enable terrain and restore auto-switching
      const tp = await Cesium.CesiumTerrainProvider.fromIonAssetId(1)
      globe.terrainProvider = tp
      setAutoSwitch(true)
      return 'Terrain enabled'
    } else {
      globe.terrainProvider = new Cesium.EllipsoidTerrainProvider()
      return 'Terrain flattened'
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

const listProviders: CommandEntry = {
  id: 'core:list-providers',
  name: 'List AI providers',
  module: 'core',
  category: 'system',
  description: 'Show connected AI providers and available Ollama models',
  patterns: ['list providers', 'show providers', 'providers', 'models', 'list models', 'which ai'],
  params: [],
  handler: async () => {
    const { getProviders } = await import('./router')
    const active = getProviders()

    const lines: string[] = ['**Connected providers** (first = preferred):']
    if (active.length === 0) {
      lines.push('  None')
    } else {
      for (const p of active) {
        const avail = await p.available()
        lines.push(`  • ${p.name}${avail ? '' : ' (unavailable)'}`)
      }
    }

    // Check Ollama for available models
    try {
      const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const data = await res.json()
        const models: { name: string; details?: { parameter_size?: string } }[] = data.models || []
        if (models.length > 0) {
          lines.push('')
          lines.push('**Ollama models** (local):')
          for (const m of models) {
            const size = m.details?.parameter_size || ''
            lines.push(`  • ${m.name}${size ? ` (${size})` : ''}`)
          }
          lines.push('')
          lines.push('Switch with: `set provider ollama <model>`')
        }
      }
    } catch { /* Ollama not running */ }

    ;(listProviders as any)._lastOutput = lines.join('\n')
  },
}

const pullModel: CommandEntry = {
  id: 'core:pull-model',
  name: 'Pull Ollama model',
  module: 'core',
  category: 'system',
  description: 'Download an Ollama model (e.g. "pull model llama3.1:8b")',
  patterns: [
    'pull model {model}', 'pull {model}', 'download model {model}',
    'ollama pull {model}', 'install model {model}',
  ],
  params: [
    { name: 'model', type: 'string', required: true, description: 'Model name (e.g. llama3.1:8b)' },
  ],
  handler: async (params) => {
    const model = String(params.model ?? '').trim()
    if (!model) {
      ;(pullModel as any)._lastOutput = 'Usage: `pull model llama3.1:8b`'
      return
    }

    // Start pull (streaming progress)
    try {
      const res = await fetch('http://localhost:11434/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      })
      if (!res.ok) {
        ;(pullModel as any)._lastOutput = `Failed to pull ${model}: ${res.statusText}`
        return
      }

      // Read streaming progress
      const reader = res.body?.getReader()
      if (!reader) {
        ;(pullModel as any)._lastOutput = `Pulling ${model}...`
        return
      }

      const decoder = new TextDecoder()
      let lastStatus = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const data = JSON.parse(line)
            if (data.status) lastStatus = data.status
          } catch {}
        }
      }

      if (lastStatus === 'success') {
        ;(pullModel as any)._lastOutput = `**${model}** downloaded successfully.\n\nSwitch to it with: \`set provider ollama ${model}\``
      } else {
        ;(pullModel as any)._lastOutput = `Pull ${model}: ${lastStatus || 'done'}`
      }
    } catch {
      ;(pullModel as any)._lastOutput = 'Ollama is not running. Start it with `ollama serve`.'
    }
  },
}

const setProvider: CommandEntry = {
  id: 'core:set-provider',
  name: 'Set AI provider',
  module: 'core',
  category: 'system',
  description: 'Configure an AI provider. Use "ollama <model>" to switch to a local model.',
  patterns: [
    'set provider {provider} {key}',
    'set provider {provider}',
    'set key {key}',
    'set api key {key}',
    'use {provider} {key}',
    'use {provider}',
  ],
  params: [
    { name: 'provider', type: 'string', required: false, description: 'Provider name' },
    { name: 'key', type: 'string', required: false, description: 'API key' },
  ],
  handler: async (params) => {
    const raw = String(params._raw ?? '').trim()
    let providerName = String(params.provider ?? '').toLowerCase().trim()
    let key = String(params.key ?? '').trim()

    // Handle "set key sk-ant-..." shorthand (auto-detect provider from key prefix)
    if (!providerName || providerName === 'undefined') {
      // The "key" might be in providerName position
      const possibleKey = providerName
      if (key.startsWith('sk-ant-') || possibleKey.startsWith('sk-ant-')) {
        providerName = 'anthropic'
        key = key || possibleKey
      } else if (key.startsWith('sk-') || possibleKey.startsWith('sk-')) {
        providerName = 'openai'
        key = key || possibleKey
      } else if (key.startsWith('eyJ') || possibleKey.startsWith('eyJ')) {
        // Cesium token
        const { useStore } = await import('@/store')
        useStore.getState().setCesiumToken(key || possibleKey)
        console.log('[provider] Cesium Ion token set')
        return
      }
    }

    // Auto-detect provider from key if name not given but key is in first param
    if (providerName && !key) {
      if (providerName.startsWith('sk-ant-')) { key = providerName; providerName = 'anthropic' }
      else if (providerName.startsWith('sk-')) { key = providerName; providerName = 'openai' }
      else if (providerName.startsWith('sk-or-')) { key = providerName; providerName = 'openrouter' }
    }

    // Normalize provider name
    if (providerName === 'claude' || providerName === 'anthropic') providerName = 'anthropic'
    else if (providerName === 'gpt' || providerName === 'chatgpt') providerName = 'openai'

    // Handle "ollama llama3" or "ollama nemotron-3-nano" as provider + model
    const validProviders = ['anthropic', 'openai', 'ollama', 'openrouter']
    if (!validProviders.includes(providerName) && providerName.startsWith('ollama ')) {
      key = providerName.slice(7).trim()  // extract model name
      providerName = 'ollama'
    }
    // Also handle "llama3", "nemotron", etc. as implicit ollama
    if (!validProviders.includes(providerName)) {
      // Check if it looks like a model name — try ollama
      key = providerName
      providerName = 'ollama'
    }

    // Ollama doesn't need a key — the "key" param is actually the model name
    let model: string | undefined
    if (providerName === 'ollama') {
      const requested = key || localStorage.getItem('ee-ollama-model') || ''
      // Fuzzy match against installed Ollama models
      if (requested) {
        try {
          const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) })
          if (res.ok) {
            const data = await res.json()
            const installed: string[] = (data.models || []).map((m: any) => m.name)
            // Exact match first, then prefix/substring match
            model = installed.find(m => m === requested)
              || installed.find(m => m.startsWith(requested))
              || installed.find(m => m.includes(requested))
              || requested  // fall through with original name
          }
        } catch { /* Ollama not running */ }
      }
      if (!model) model = requested || undefined
      key = ''
    }

    // Retrieve stored key if none provided
    if (!key && providerName !== 'ollama') {
      key = localStorage.getItem(`ee-${providerName}-key`)
        || (providerName === 'anthropic' ? (import.meta.env.VITE_ANTHROPIC_API_KEY || '') : '')
    }

    // Persist the key
    if (key) {
      localStorage.setItem(`ee-${providerName}-key`, key)
    }
    if (providerName === 'ollama' && model) {
      localStorage.setItem('ee-ollama-model', model)
    }

    const { addProvider } = await import('./init')
    addProvider(providerName as any, key, { model, preferred: true })
    console.log(`[provider] ${providerName} provider configured${model ? ` (model: ${model})` : ''}`)
  },
}

const setCesiumToken: CommandEntry = {
  id: 'core:set-cesium-token',
  name: 'Set Cesium token',
  module: 'core',
  category: 'system',
  description: 'Set a custom Cesium Ion access token',
  aiHidden: true,
  patterns: ['set cesium token {key}', 'cesium token {key}'],
  params: [{ name: 'key', type: 'string', required: true, description: 'Cesium Ion token' }],
  handler: async (params) => {
    const key = String(params.key).trim()
    const { useStore } = await import('@/store')
    useStore.getState().setCesiumToken(key)
    console.log('[provider] Cesium Ion token set (reload to apply)')
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

// --- Base map style ---

const baseMap: CommandEntry = {
  id: 'core:base-map',
  name: 'Change base map',
  module: 'core',
  category: 'view',
  description: 'Switch base map style (default, satellite, dark, light, road)',
  patterns: [
    'base map {style}',
    'map style {style}',
    'switch map to {style}',
    'default map',
    'dark map',
    'light map',
    'satellite map',
    'road map',
    'political map',
    'normal map',
    'reset map',
  ],
  params: [
    {
      name: 'style',
      type: 'enum',
      required: true,
      description: 'Map style',
      options: ['default', 'satellite', 'dark', 'light', 'road'],
    },
  ],
  handler: async (params) => {
    const raw = String(params._raw ?? '').toLowerCase()
    let style = String(params.style ?? '').toLowerCase().trim()

    // Handle exact-match patterns (no {style} param extracted)
    if (!style || style === 'undefined') {
      if (raw.includes('dark')) style = 'dark'
      else if (raw.includes('light') || raw.includes('political')) style = 'light'
      else if (raw.includes('satellite')) style = 'satellite'
      else if (raw.includes('road')) style = 'road'
      else if (raw.includes('default') || raw.includes('normal') || raw.includes('reset')) style = 'default'
      else style = 'default'
    }

    // Normalize aliases
    if (style === 'political' || style === 'terrain') style = 'light'

    const styles = getBaseMapStyles()
    const match = styles.find(s => s.id === style)
    if (!match) {
      const available = styles.map(s => s.id).join(', ')
      console.log(`[core] Unknown map style "${style}". Available: ${available}`)
      return
    }

    await setBaseMapStyle(style as BaseMapStyle)
  },
}

const listBaseMaps: CommandEntry = {
  id: 'core:list-maps',
  name: 'List base maps',
  module: 'core',
  category: 'view',
  description: 'Show available base map styles',
  patterns: ['list maps', 'map styles', 'available maps', 'base maps'],
  params: [],
  handler: () => {
    const styles = getBaseMapStyles()
    const current = getBaseMapStyle()
    const lines = styles.map(s => {
      const dot = s.id === current ? '●' : '○'
      return `${dot} ${s.name} — ${s.description}`
    })
    const output = `**Base Maps** (${styles.length} available)\n\n${lines.join('\n')}\n\nSay "dark map" or "base map satellite" to switch.`
    ;(listBaseMaps as any)._lastOutput = output
  },
}

// --- Look-at command (ground-level views) ---

const lookAt: CommandEntry = {
  id: 'core:look-at',
  name: 'Look at target',
  module: 'core',
  category: 'navigation',
  chatOnly: true, // Force through chat path so AI can chain geocode → look-at → screenshot
  description: 'Position the camera near a target and look toward it. Use for ground-level, eye-level, drone, or any angled view of a landmark or feature. The camera is placed at a specified distance and height from the target, aimed toward a point at targetHeight on the target. Parameters: lat/lon of the target, distance (meters from target, default 200), cameraHeight (camera altitude above ground in meters, default 30), targetHeight (height of the thing to look at in meters above ground, default 30), heading (direction camera is FROM the target: 0=south looking north, 90=west looking east, default 0).',
  patterns: ['look at {place}', 'view {place} from ground'],
  params: [
    { name: 'lat', type: 'number', required: true, description: 'Target latitude in degrees' },
    { name: 'lon', type: 'number', required: true, description: 'Target longitude in degrees' },
    { name: 'distance', type: 'number', required: false, description: 'Distance from target in meters (default 200)' },
    { name: 'cameraHeight', type: 'number', required: false, description: 'Camera height above ground in meters (default 30)' },
    { name: 'targetHeight', type: 'number', required: false, description: 'Height of the feature to look at in meters above ground. E.g. Big Ben clock face = 55, Eiffel Tower top = 330, a house = 10. (default 30)' },
    { name: 'heading', type: 'number', required: false, description: 'Direction camera is FROM the target in degrees. 0 = camera south of target looking north. 90 = camera west looking east. (default 0)' },
  ],
  handler: async (params) => {
    const viewer = getViewer()
    if (!viewer) return 'No viewer available'

    const targetLat = typeof params.lat === 'number' ? params.lat : parseFloat(String(params.lat))
    const targetLon = typeof params.lon === 'number' ? params.lon : parseFloat(String(params.lon))
    if (isNaN(targetLat) || isNaN(targetLon)) return 'Invalid coordinates'

    const parseOr = (val: unknown, fallback: number) => {
      if (typeof val === 'number') return val
      if (val != null) { const n = parseFloat(String(val)); if (!isNaN(n)) return n }
      return fallback
    }
    const distance = parseOr(params.distance, 200)
    const cameraHeight = parseOr(params.cameraHeight, 30)
    const targetHeight = parseOr(params.targetHeight, 30)
    const headingDeg = parseOr(params.heading, 0)

    playRumble()

    // Compute camera position: offset from target by `distance` meters
    // Heading 0 = camera is SOUTH of target, looking NORTH toward it.
    const headingRad = Cesium.Math.toRadians(headingDeg)

    // Approximate meter offsets using local tangent plane
    const metersPerDegreeLat = 111_320
    const metersPerDegreeLon = 111_320 * Math.cos(Cesium.Math.toRadians(targetLat))

    const latOffset = -Math.cos(headingRad) * distance / metersPerDegreeLat
    const lonOffset = -Math.sin(headingRad) * distance / metersPerDegreeLon

    const cameraLat = targetLat + latOffset
    const cameraLon = targetLon + lonOffset

    // Compute pitch based on the height difference between camera and target feature.
    // In Cesium: pitch 0 = horizontal, negative = looking down, positive not used.
    // We want to look from cameraHeight toward targetHeight at the given distance.
    const heightDiff = targetHeight - cameraHeight // positive = target above camera
    const pitchRad = Math.atan2(heightDiff, distance) // positive when looking up, negative when looking down
    // Cesium pitch: 0 = horizontal, -PI/2 = straight down. atan2 gives us the right sign.

    // Camera looks toward target: same heading value as input
    // (heading 0 = camera south, look north = Cesium heading 0°)
    const lookHeadingRad = headingRad

    console.log(`[look-at] Camera at (${cameraLat.toFixed(5)}, ${cameraLon.toFixed(5)}, ${cameraHeight}m), target at (${targetLat}, ${targetLon}, ${targetHeight}m), heading ${headingDeg.toFixed(0)}°, pitch ${Cesium.Math.toDegrees(pitchRad).toFixed(1)}°, distance ${distance}m`)

    await flyToAsync(viewer.camera, {
      destination: Cesium.Cartesian3.fromDegrees(cameraLon, cameraLat, cameraHeight),
      orientation: {
        heading: lookHeadingRad,
        pitch: pitchRad,
        roll: 0,
      },
      duration: 2.0,
    })

    const dirLabel = headingDeg === 0 ? 'south' : headingDeg === 90 ? 'west' : headingDeg === 180 ? 'north' : headingDeg === 270 ? 'east' : `${headingDeg}°`
    return `Camera positioned ${Math.round(distance)}m ${dirLabel} of target at ${Math.round(cameraHeight)}m, looking toward (${targetLat.toFixed(4)}, ${targetLon.toFixed(4)}) at ${Math.round(targetHeight)}m height. Pitch: ${Cesium.Math.toDegrees(pitchRad).toFixed(1)}°.`
  },
}

// --- Orbit command ---

const orbit: CommandEntry = {
  id: 'core:orbit',
  name: 'Orbit',
  module: 'core',
  category: 'navigation',
  description: 'Start or stop orbiting around a target point. Call with lat/lon to start orbiting, or call with no args to stop. Speed is degrees per second (default 5 = ~72s per revolution).',
  patterns: ['orbit', 'orbit around', 'stop orbit'],
  params: [
    { name: 'lat', type: 'number', required: false, description: 'Target latitude (omit to stop orbiting)' },
    { name: 'lon', type: 'number', required: false, description: 'Target longitude' },
    { name: 'distance', type: 'number', required: false, description: 'Distance from target in meters (default 300)' },
    { name: 'cameraHeight', type: 'number', required: false, description: 'Camera height above ground in meters (default 100)' },
    { name: 'targetHeight', type: 'number', required: false, description: 'Height of the feature to orbit around in meters (default 30)' },
    { name: 'speed', type: 'number', required: false, description: 'Orbit speed in degrees per second (default 5)' },
  ],
  handler: async (params) => {
    // No lat/lon = toggle off
    if (params.lat == null || params.lon == null) {
      if (isOrbiting()) {
        stopOrbit()
        return 'Orbit stopped'
      }
      return 'Not currently orbiting. Provide lat/lon to start.'
    }

    const lat = typeof params.lat === 'number' ? params.lat : parseFloat(String(params.lat))
    const lon = typeof params.lon === 'number' ? params.lon : parseFloat(String(params.lon))
    if (isNaN(lat) || isNaN(lon)) return 'Invalid coordinates'

    const parseOr = (val: unknown, fallback: number) => {
      if (typeof val === 'number') return val
      if (val != null) { const n = parseFloat(String(val)); if (!isNaN(n)) return n }
      return fallback
    }

    playRumble()
    startOrbit({
      targetLat: lat,
      targetLon: lon,
      distance: parseOr(params.distance, 300),
      cameraHeight: parseOr(params.cameraHeight, 100),
      targetHeight: parseOr(params.targetHeight, 30),
      speed: parseOr(params.speed, 5),
    })
    return `Orbiting (${lat.toFixed(4)}, ${lon.toFixed(4)}) — say "stop orbit" to end`
  },
}

// --- Agent message board ---

interface AgentMessage {
  from: string
  text: string
  timestamp: number
}

const messageBoard: AgentMessage[] = []
const MAX_MESSAGES = 100

const postMessage: CommandEntry = {
  id: 'core:post-message',
  name: 'Post message',
  module: 'core',
  category: 'system',
  description: 'Post a message to the shared agent message board. Use this to communicate with other AI agents connected to the same session. Include a "from" name to identify yourself.',
  patterns: ['post message', 'send message'],
  params: [
    { name: 'from', type: 'string', required: true, description: 'Your identifier (e.g. "claude-code", "claude-desktop")' },
    { name: 'text', type: 'string', required: true, description: 'Message text' },
  ],
  handler: async (params) => {
    const from = String(params.from || 'unknown')
    const text = String(params.text || '')
    if (!text) return 'Empty message'
    messageBoard.push({ from, text, timestamp: Date.now() })
    if (messageBoard.length > MAX_MESSAGES) messageBoard.shift()
    return `Message posted by ${from} (${messageBoard.length} total)`
  },
}

const readMessages: CommandEntry = {
  id: 'core:read-messages',
  name: 'Read messages',
  module: 'core',
  category: 'system',
  description: 'Read recent messages from the shared agent message board. Returns the last N messages (default 10). Use this to see what other AI agents have communicated.',
  patterns: ['read messages', 'check messages'],
  params: [
    { name: 'count', type: 'number', required: false, description: 'Number of recent messages to return (default 10)' },
    { name: 'since', type: 'number', required: false, description: 'Only return messages after this timestamp (milliseconds)' },
  ],
  handler: async (params) => {
    const count = typeof params.count === 'number' ? params.count : 10
    const since = typeof params.since === 'number' ? params.since : 0

    let msgs = messageBoard
    if (since > 0) msgs = msgs.filter(m => m.timestamp > since)
    msgs = msgs.slice(-count)

    if (msgs.length === 0) return 'No messages'

    return msgs.map(m => {
      const time = new Date(m.timestamp).toLocaleTimeString()
      return `[${time}] ${m.from}: ${m.text}`
    }).join('\n')
  },
}

/** All core commands */
export const coreCommands: CommandEntry[] = [
  goTo, resetView, zoomIn, zoomOut, zoomTo, faceDirection, lookAt, orbit,
  toggleBuildings, toggleTerrain, toggleLighting, setTimeOfDay,
  baseMap, listBaseMaps,
  muteToggle, whatCanYouDo, fullscreen, listProviders, pullModel, setProvider, setCesiumToken,
  postMessage, readMessages,
]
