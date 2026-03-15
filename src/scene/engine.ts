/**
 * Shared viewer reference and scene state.
 * CesiumViewer sets this on init, commands and plugins read it.
 * Avoids fragile window globals.
 */

import * as Cesium from 'cesium'

let _viewer: Cesium.Viewer | null = null

export function setViewer(viewer: Cesium.Viewer | null): void {
  _viewer = viewer
  console.log('[engine] Viewer', viewer ? 'set' : 'cleared')
}

export function getViewer(): Cesium.Viewer | null {
  return _viewer
}

// Building tileset management
export type BuildingMode = 'osm' | 'photorealistic'

let _osmTileset: Cesium.Cesium3DTileset | null = null
let _photoTileset: Cesium.Cesium3DTileset | null = null
let _buildingMode: BuildingMode = 'osm'
let _autoSwitch = true // altitude-based auto-switching enabled by default

// Hysteresis thresholds (meters)
const SWITCH_DOWN = 50_000   // switch to photorealistic below 50km
const SWITCH_UP   = 55_000   // switch back to OSM above 55km

export function setBuildingTilesets(osm: Cesium.Cesium3DTileset | null, photo: Cesium.Cesium3DTileset | null): void {
  _osmTileset = osm
  _photoTileset = photo
}

export function getBuildingMode(): BuildingMode {
  return _buildingMode
}

export function setBuildingMode(mode: BuildingMode): void {
  if (mode === _buildingMode) return
  _buildingMode = mode
  if (mode === 'photorealistic') {
    if (_osmTileset) _osmTileset.show = false
    if (_photoTileset) _photoTileset.show = true
    if (_viewer) _viewer.scene.globe.show = false
  } else {
    if (_photoTileset) _photoTileset.show = false
    if (_osmTileset) _osmTileset.show = true
    if (_viewer) _viewer.scene.globe.show = true
  }
  console.log(`[engine] Building mode: ${mode}`)
}

/** Toggle auto-switching on/off (manual toggle command disables auto) */
export function setAutoSwitch(enabled: boolean): void {
  _autoSwitch = enabled
}

/** Base maps where photorealistic buildings make visual sense */
const PHOTO_COMPATIBLE_MAPS: Set<BaseMapStyle> = new Set(['default', 'satellite'])

/**
 * Called every frame from the postRender callback.
 * Automatically switches building mode based on camera altitude with hysteresis.
 * Photorealistic buildings only activate on satellite-family base maps.
 */
export function updateBuildingMode(altitude: number): void {
  if (!_autoSwitch) return
  if (!_photoTileset) return // photorealistic not available

  const photoAllowed = PHOTO_COMPATIBLE_MAPS.has(_currentBaseMap)

  if (photoAllowed && _buildingMode === 'osm' && altitude < SWITCH_DOWN) {
    setBuildingMode('photorealistic')
  } else if (_buildingMode === 'photorealistic' && (altitude > SWITCH_UP || !photoAllowed)) {
    setBuildingMode('osm')
  }
}

// ── Base map imagery styles ──

export type BaseMapStyle = 'default' | 'satellite' | 'dark' | 'light' | 'road'

interface BaseMapDef {
  name: string
  description: string
  create: () => Promise<Cesium.ImageryProvider> | Cesium.ImageryProvider
}

const BASE_MAPS: Record<BaseMapStyle, BaseMapDef> = {
  default: {
    name: 'Default',
    description: 'Satellite imagery with labels',
    create: () => Cesium.createWorldImageryAsync({
      style: Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
    }),
  },
  satellite: {
    name: 'Satellite',
    description: 'Satellite imagery (no labels)',
    create: () => Cesium.createWorldImageryAsync({
      style: Cesium.IonWorldImageryStyle.AERIAL,
    }),
  },
  dark: {
    name: 'Dark',
    description: 'CartoDB Dark Matter',
    create: () => new Cesium.UrlTemplateImageryProvider({
      url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      credit: new Cesium.Credit('CartoDB'),
      maximumLevel: 18,
    }),
  },
  light: {
    name: 'Light',
    description: 'CartoDB Positron (light political)',
    create: () => new Cesium.UrlTemplateImageryProvider({
      url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      credit: new Cesium.Credit('CartoDB'),
      maximumLevel: 18,
    }),
  },
  road: {
    name: 'Road',
    description: 'Road map with labels',
    create: () => Cesium.createWorldImageryAsync({
      style: Cesium.IonWorldImageryStyle.ROAD,
    }),
  },
}

let _currentBaseMap: BaseMapStyle = 'default'

export function getBaseMapStyle(): BaseMapStyle { return _currentBaseMap }
export function getBaseMapStyles(): { id: BaseMapStyle; name: string; description: string }[] {
  return Object.entries(BASE_MAPS).map(([id, def]) => ({
    id: id as BaseMapStyle,
    name: def.name,
    description: def.description,
  }))
}

export async function setBaseMapStyle(style: BaseMapStyle): Promise<boolean> {
  if (!_viewer) return false
  const def = BASE_MAPS[style]
  if (!def) return false
  if (style === _currentBaseMap) return true

  const provider = await def.create()

  // Replace the base imagery layer (index 0)
  const layers = _viewer.imageryLayers
  if (layers.length > 0) {
    layers.remove(layers.get(0), true)
  }
  layers.addImageryProvider(provider, 0)
  _currentBaseMap = style

  // Force OSM buildings if new base map isn't compatible with photorealistic
  if (_buildingMode === 'photorealistic' && !PHOTO_COMPATIBLE_MAPS.has(style)) {
    setBuildingMode('osm')
  }

  console.log(`[engine] Base map: ${def.name}`)
  return true
}
