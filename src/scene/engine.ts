/**
 * Shared viewer reference.
 * CesiumViewer sets this on init, core-commands reads it.
 * Avoids fragile window globals.
 */

import type * as Cesium from 'cesium'

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

/**
 * Called every frame from the postRender callback.
 * Automatically switches building mode based on camera altitude with hysteresis.
 */
export function updateBuildingMode(altitude: number): void {
  if (!_autoSwitch) return
  if (!_photoTileset) return // photorealistic not available

  if (_buildingMode === 'osm' && altitude < SWITCH_DOWN) {
    setBuildingMode('photorealistic')
  } else if (_buildingMode === 'photorealistic' && altitude > SWITCH_UP) {
    setBuildingMode('osm')
  }
}
