/**
 * NASA GIBS Satellite Imagery App
 *
 * Provides access to NASA's Global Imagery Browse Services (GIBS) via WMTS.
 * Layers include MODIS true color, VIIRS night lights, sea surface temperature,
 * and cloud cover. All layers are registered with the layer manager and exposed
 * as AI commands for natural language control.
 */

import * as Cesium from 'cesium'
import type { WorldscopeApp } from '@/apps/types'
import type { CommandEntry } from '@/ai/types'
import type { LayerDef } from '@/features/layers/types'
import { registerLayer, showLayer, hideLayer, toggleLayer, getLayer } from '@/features/layers/manager'
import { registry } from '@/ai/registry'

// ── GIBS WMTS configuration ──

const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best'
const TILE_MATRIX_SET = '250m'
const MAX_LEVEL = 8

function today(): string {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

function gibsProvider(layer: string, date: string, format: 'jpeg' | 'png' = 'jpeg'): () => Cesium.ImageryProvider {
  return () =>
    new Cesium.WebMapTileServiceImageryProvider({
      url: `${GIBS_BASE}/{Layer}/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.${format === 'jpeg' ? 'jpg' : 'png'}`,
      layer,
      style: 'default',
      tileMatrixSetID: TILE_MATRIX_SET,
      maximumLevel: MAX_LEVEL,
      format: `image/${format}`,
      tilingScheme: new Cesium.GeographicTilingScheme(),
      credit: new Cesium.Credit('NASA GIBS'),
      subdomains: undefined as any,
      dimensions: {
        Layer: layer,
        Time: date,
        TileMatrixSet: TILE_MATRIX_SET,
      },
    })
}

// ── Layer definitions ──

const GIBS_LAYERS: LayerDef[] = [
  {
    id: 'gibs-modis-truecolor',
    name: 'MODIS True Color',
    kind: 'imagery',
    category: 'satellite',
    description: 'MODIS Terra corrected reflectance true color imagery from NASA GIBS',
    defaultOn: false,
    imageryProvider: gibsProvider('MODIS_Terra_CorrectedReflectance_TrueColor', today(), 'jpeg'),
  },
  {
    id: 'gibs-viirs-nightlights',
    name: 'Night Lights (VIIRS)',
    kind: 'imagery',
    category: 'satellite',
    description: 'VIIRS Black Marble night lights composite from NASA GIBS',
    defaultOn: false,
    imageryProvider: gibsProvider('VIIRS_Black_Marble', '2023-01-01', 'png'),
  },
  {
    id: 'gibs-sst',
    name: 'Sea Surface Temperature',
    kind: 'imagery',
    category: 'satellite',
    description: 'GHRSST L4 MUR sea surface temperature analysis from NASA GIBS',
    defaultOn: false,
    imageryProvider: gibsProvider('GHRSST_L4_MUR_Sea_Surface_Temperature', today(), 'png'),
  },
  {
    id: 'gibs-cloud-cover',
    name: 'Cloud Cover',
    kind: 'imagery',
    category: 'satellite',
    description: 'MODIS Terra cloud top temperature (night) from NASA GIBS',
    defaultOn: false,
    imageryProvider: gibsProvider('MODIS_Terra_Cloud_Top_Temp_Night', today(), 'png'),
  },
]

// ── Helper: resolve a GIBS layer by fuzzy name ──

const LAYER_ALIASES: Record<string, string> = {
  'true color': 'gibs-modis-truecolor',
  'truecolor': 'gibs-modis-truecolor',
  'modis': 'gibs-modis-truecolor',
  'satellite': 'gibs-modis-truecolor',
  'satellite view': 'gibs-modis-truecolor',
  'satellite imagery': 'gibs-modis-truecolor',
  'night lights': 'gibs-viirs-nightlights',
  'nightlights': 'gibs-viirs-nightlights',
  'night': 'gibs-viirs-nightlights',
  'viirs': 'gibs-viirs-nightlights',
  'black marble': 'gibs-viirs-nightlights',
  'city lights': 'gibs-viirs-nightlights',
  'lights at night': 'gibs-viirs-nightlights',
  'sea surface temperature': 'gibs-sst',
  'sea temperature': 'gibs-sst',
  'sst': 'gibs-sst',
  'ocean temperature': 'gibs-sst',
  'water temperature': 'gibs-sst',
  'cloud cover': 'gibs-cloud-cover',
  'clouds': 'gibs-cloud-cover',
  'cloud': 'gibs-cloud-cover',
  'cloud top': 'gibs-cloud-cover',
  'cloud temperature': 'gibs-cloud-cover',
}

function resolveGibsLayer(input: string): string | undefined {
  const q = input.toLowerCase().trim()
  // Direct ID match
  if (GIBS_LAYERS.some(l => l.id === q)) return q
  // Alias match
  if (LAYER_ALIASES[q]) return LAYER_ALIASES[q]
  // Partial match against layer names
  const match = GIBS_LAYERS.find(
    l => l.name.toLowerCase().includes(q) || l.id.includes(q),
  )
  return match?.id
}

// ── Commands ──

function buildGibsPatterns(): string[] {
  const verbs = ['show', 'hide', 'toggle', 'turn on', 'turn off']
  const patterns: string[] = []

  // Explicit alias patterns
  for (const alias of Object.keys(LAYER_ALIASES)) {
    for (const verb of verbs) {
      patterns.push(`${verb} ${alias}`)
    }
  }

  // Layer name patterns
  for (const def of GIBS_LAYERS) {
    for (const verb of verbs) {
      patterns.push(`${verb} ${def.name.toLowerCase()}`)
    }
  }

  return patterns
}

const toggleGibsCmd: CommandEntry = {
  id: 'gibs:toggle',
  name: 'Toggle GIBS layer',
  module: 'gibs',
  category: 'data',
  description: 'Toggle a NASA GIBS satellite imagery layer (true color, night lights, sea temperature, clouds)',
  patterns: buildGibsPatterns(),
  params: [
    {
      name: 'layer',
      type: 'string',
      required: true,
      description: 'GIBS layer name (true color, night lights, sea temperature, clouds)',
    },
    {
      name: 'action',
      type: 'enum',
      required: false,
      description: 'Whether to show, hide, or toggle the layer',
      options: ['show', 'hide', 'toggle'],
    },
  ],
  handler: async (params) => {
    const raw = String(params._raw ?? '').toLowerCase()

    let input = String(params.layer ?? '').toLowerCase().trim()
    if (!input || input === 'undefined') {
      input = raw
        .replace(/^(show|hide|toggle|turn on|turn off)\s+/, '')
        .replace(/\s+(on|off)$/, '')
        .trim()
    }

    const layerId = resolveGibsLayer(input)
    if (!layerId) {
      const available = GIBS_LAYERS.map(l => l.name).join(', ')
      return `Unknown GIBS layer "${input}". Available: ${available}`
    }

    const action = String(params.action ?? '').toLowerCase()
    const wantsHide = action === 'hide' || raw.startsWith('hide') || raw.startsWith('turn off') || raw.endsWith('off')
    const wantsShow = action === 'show' || raw.startsWith('show') || raw.startsWith('turn on') || raw.endsWith(' on')

    if (wantsHide) {
      hideLayer(layerId)
    } else if (wantsShow) {
      await showLayer(layerId)
    } else {
      await toggleLayer(layerId)
    }

    const live = getLayer(layerId)
    const state = live?.visible ? 'on' : 'off'
    const name = live?.def.name ?? layerId
    return `${name}: ${state}`
  },
}

const listGibsCmd: CommandEntry = {
  id: 'gibs:list',
  name: 'List GIBS layers',
  module: 'gibs',
  category: 'data',
  description: 'List available NASA GIBS satellite imagery layers',
  patterns: [
    'list gibs layers',
    'gibs layers',
    'satellite layers',
    'nasa imagery',
    'available satellite imagery',
    'what satellite layers',
  ],
  params: [],
  handler: () => {
    const lines = GIBS_LAYERS.map(def => {
      const live = getLayer(def.id)
      const dot = live?.visible ? '●' : '○'
      return `${dot} ${def.name} — ${def.description}`
    })
    return `**NASA GIBS Satellite Imagery** (${GIBS_LAYERS.length} layers)\n\n${lines.join('\n')}\n\nSay "show night lights" or "show satellite view" to enable a layer.`
  },
}

const gibsCommands: CommandEntry[] = [toggleGibsCmd, listGibsCmd]

// ── App definition ──

const gibsApp: WorldscopeApp = {
  id: 'gibs',
  name: 'NASA GIBS Imagery',
  description: 'NASA satellite imagery layers (MODIS, VIIRS, sea surface temperature, clouds)',
  autoActivate: true,

  activate() {
    // Register all GIBS imagery layers with the layer manager
    for (const def of GIBS_LAYERS) {
      registerLayer(def)
    }

    // Register AI commands
    registry.registerAll(gibsCommands)

    console.log(`[gibs] Activated with ${GIBS_LAYERS.length} satellite imagery layers`)

    return {
      commands: gibsCommands,
      layers: GIBS_LAYERS,
    }
  },

  deactivate() {
    // Hide all GIBS layers
    for (const def of GIBS_LAYERS) {
      hideLayer(def.id)
    }

    // Unregister AI commands
    registry.unregisterModule('gibs')

    console.log('[gibs] Deactivated')
  },
}

export default gibsApp
