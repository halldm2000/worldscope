/**
 * Earthquake Tracker App
 *
 * Displays recent M2.5+ earthquakes from the USGS real-time feed as a
 * GeoJSON layer on the globe. Provides commands to show/hide the layer
 * and query the latest earthquake with an option to fly to its location.
 */

import type { WorldscopeApp, AppContext, AppResources } from '@/apps/types'
import type { CommandEntry } from '@/ai/types'
import type { LayerDef } from '@/features/layers/types'

const USGS_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'
const LAYER_ID = 'earthquake-usgs-2.5'

const earthquakeLayer: LayerDef = {
  id: LAYER_ID,
  name: 'Earthquakes (M2.5+ Today)',
  kind: 'geojson',
  category: 'hazards',
  description: 'USGS real-time feed of M2.5+ earthquakes in the past day',
  defaultOn: true,
  url: USGS_FEED,
  style: {
    stroke: '#ff4444',
    strokeWidth: 2,
    fill: 'rgba(255, 68, 68, 0.3)',
  },
}

function makeCommands(ctx: AppContext): CommandEntry[] {
  const showCmd: CommandEntry = {
    id: 'earthquake:show',
    name: 'Show earthquakes',
    module: 'earthquake',
    category: 'feature',
    description: 'Show the USGS earthquake layer on the globe',
    patterns: ['show earthquakes', 'earthquakes on', 'turn on earthquakes'],
    params: [],
    handler: async () => {
      const ok = await ctx.showLayer(LAYER_ID)
      return ok ? 'Earthquake layer visible' : 'Failed to show earthquake layer'
    },
  }

  const hideCmd: CommandEntry = {
    id: 'earthquake:hide',
    name: 'Hide earthquakes',
    module: 'earthquake',
    category: 'feature',
    description: 'Hide the USGS earthquake layer',
    patterns: ['hide earthquakes', 'earthquakes off', 'turn off earthquakes'],
    params: [],
    handler: () => {
      const ok = ctx.hideLayer(LAYER_ID)
      return ok ? 'Earthquake layer hidden' : 'Earthquake layer not found'
    },
  }

  const latestCmd: CommandEntry = {
    id: 'earthquake:latest',
    name: 'Latest earthquake',
    module: 'earthquake',
    category: 'feature',
    description: 'Fetch and describe the most recent M2.5+ earthquake. Offers to fly to the location.',
    patterns: [
      'latest earthquake', 'recent earthquake', 'last earthquake',
      'biggest earthquake', 'earthquake info',
    ],
    params: [
      { name: 'flyTo', type: 'boolean', required: false, description: 'If true, fly to the earthquake location' },
    ],
    handler: async (params) => {
      try {
        const resp = await fetch(USGS_FEED)
        const data = await resp.json()
        const features = data.features
        if (!features || features.length === 0) {
          return 'No recent M2.5+ earthquakes found.'
        }

        // Sort by time descending (most recent first)
        features.sort((a: any, b: any) => b.properties.time - a.properties.time)
        const quake = features[0]
        const props = quake.properties
        const [lon, lat, depthKm] = quake.geometry.coordinates

        const mag = props.mag.toFixed(1)
        const place = props.place || 'Unknown location'
        const time = new Date(props.time).toLocaleString()
        const url = props.url || ''

        // Fly to the earthquake location if requested
        if (params.flyTo) {
          const viewer = ctx.getViewer()
          if (viewer) {
            const Cesium = await import('cesium')
            viewer.camera.flyTo({
              destination: Cesium.Cartesian3.fromDegrees(lon, lat, 500_000),
              duration: 2.0,
            })
          }
        }

        const lines = [
          `**M${mag}** — ${place}`,
          `Time: ${time}`,
          `Depth: ${depthKm.toFixed(1)} km`,
          `Coordinates: ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        ]
        if (url) lines.push(`Details: ${url}`)
        if (!params.flyTo) {
          lines.push('')
          lines.push('Say "latest earthquake --flyTo" or use go-to to fly to this location.')
        }

        // Store for router to pick up
        ;(latestCmd as any)._lastOutput = lines.join('\n')
        return lines.join('\n')
      } catch (err) {
        console.error('[earthquake] Failed to fetch USGS feed:', err)
        return 'Failed to fetch earthquake data from USGS.'
      }
    },
  }

  return [showCmd, hideCmd, latestCmd]
}

export const earthquakeApp: WorldscopeApp = {
  id: 'earthquake',
  name: 'Earthquake Tracker',
  description: 'Real-time USGS earthquake feed (M2.5+ in the past day)',
  autoActivate: true,

  activate: (ctx: AppContext): AppResources => {
    return {
      commands: makeCommands(ctx),
      layers: [earthquakeLayer],
    }
  },

  deactivate: () => {
    console.log('[earthquake] Deactivated')
  },
}
