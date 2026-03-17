import * as Cesium from 'cesium'
import { getViewer } from '@/scene/engine'
import type { LayerDef, LiveLayer, GeoJsonStyle } from './types'

/**
 * Layer manager: loads, shows, hides, and tracks all data layers.
 * Lazy-loads GeoJSON on first toggle (no upfront fetch for layers that stay off).
 */

const _layers = new Map<string, LiveLayer>()

// ── Registration ──

export function registerLayer(def: LayerDef): void {
  if (_layers.has(def.id)) return
  _layers.set(def.id, { def, visible: false })
}

export function getLayer(id: string): LiveLayer | undefined {
  return _layers.get(id)
}

export function getAllLayers(): LiveLayer[] {
  return Array.from(_layers.values())
}

export function getLayersByCategory(category: string): LiveLayer[] {
  return getAllLayers().filter(l => l.def.category === category)
}

// ── Toggle ──

export async function showLayer(id: string): Promise<boolean> {
  const layer = _layers.get(id)
  if (!layer) return false
  const viewer = getViewer()
  if (!viewer) return false

  // Lazy-load on first show
  if (layer.def.kind === 'geojson' && !layer.datasource) {
    await loadGeoJson(layer, viewer)
  }
  if (layer.def.kind === 'imagery' && !layer.imageryLayer) {
    loadImagery(layer, viewer)
  }

  // Make visible
  if (layer.datasource) layer.datasource.show = true
  if (layer.imageryLayer) layer.imageryLayer.show = true
  if (layer.tileset) layer.tileset.show = true
  layer.visible = true
  return true
}

export function hideLayer(id: string): boolean {
  const layer = _layers.get(id)
  if (!layer) return false

  if (layer.datasource) layer.datasource.show = false
  if (layer.imageryLayer) layer.imageryLayer.show = false
  if (layer.tileset) layer.tileset.show = false
  layer.visible = false
  return true
}

export async function toggleLayer(id: string): Promise<boolean> {
  const layer = _layers.get(id)
  if (!layer) return false
  if (layer.visible) {
    hideLayer(id)
  } else {
    await showLayer(id)
  }
  return true
}

// ── Cleanup ──

export function removeLayer(id: string): void {
  const layer = _layers.get(id)
  if (!layer) return
  const viewer = getViewer()
  if (layer.datasource && viewer) {
    viewer.dataSources.remove(layer.datasource, true)
  }
  if (layer.imageryLayer && viewer) {
    viewer.imageryLayers.remove(layer.imageryLayer, true)
  }
  if (layer.tileset && viewer) {
    viewer.scene.primitives.remove(layer.tileset)
  }
  _layers.delete(id)
}

export function removeAllLayers(): void {
  const viewer = getViewer()
  for (const layer of _layers.values()) {
    if (layer.datasource && viewer) {
      viewer.dataSources.remove(layer.datasource, true)
    }
    if (layer.imageryLayer && viewer) {
      viewer.imageryLayers.remove(layer.imageryLayer, true)
    }
    if (layer.tileset && viewer) {
      viewer.scene.primitives.remove(layer.tileset)
    }
  }
  _layers.clear()
}

// ── Internal loaders ──

async function loadGeoJson(layer: LiveLayer, viewer: Cesium.Viewer): Promise<void> {
  const def = layer.def
  if (!def.url) return

  const style = def.style ?? { stroke: '#ffffff', strokeWidth: 1 }

  const ds = await Cesium.GeoJsonDataSource.load(def.url, {
    stroke: Cesium.Color.fromCssColorString(style.stroke),
    strokeWidth: style.strokeWidth,
    fill: style.fill
      ? Cesium.Color.fromCssColorString(style.fill)
      : Cesium.Color.TRANSPARENT,
    clampToGround: true,
  })

  // Override entity materials for consistent look (GeoJsonDataSource
  // sometimes ignores the constructor options for polylines)
  const color = Cesium.Color.fromCssColorString(style.stroke)
  const material = new Cesium.ColorMaterialProperty(color)
  for (const entity of ds.entities.values) {
    if (entity.polyline) {
      entity.polyline.material = material
      entity.polyline.width = new Cesium.ConstantProperty(style.strokeWidth)
    }
    if (entity.polygon) {
      entity.polygon.outlineColor = new Cesium.ConstantProperty(color)
      entity.polygon.outlineWidth = new Cesium.ConstantProperty(style.strokeWidth)
      entity.polygon.material = style.fill
        ? new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(style.fill))
        : new Cesium.ColorMaterialProperty(Cesium.Color.TRANSPARENT)
    }
  }

  viewer.dataSources.add(ds)
  layer.datasource = ds
}

function loadImagery(layer: LiveLayer, viewer: Cesium.Viewer): void {
  const def = layer.def
  if (!def.imageryProvider) return

  const provider = def.imageryProvider()
  const imageryLayer = viewer.imageryLayers.addImageryProvider(provider)
  layer.imageryLayer = imageryLayer
}
