import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { useStore } from '@/store'
import { setViewer } from './engine'
import { playRumble } from '@/audio/sounds'

const MAX_ALTITUDE = 25_000_000 // 25,000 km
const HOME = { lon: 10, lat: 30, height: MAX_ALTITUDE, heading: 0, pitch: -90 }

export function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const cesiumToken = useStore(s => s.cesiumToken)
  const googleMapsKey = useStore(s => s.googleMapsKey)
  const [status, setStatus] = useState({ lat: 0, lon: 0, alt: 0, heading: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!containerRef.current || !cesiumToken) return
    let disposed = false

    async function init() {
      Cesium.Ion.defaultAccessToken = cesiumToken!

      const viewer = new Cesium.Viewer(containerRef.current!, {
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        vrButton: false,
        infoBox: false,
        selectionIndicator: false,
        creditContainer: document.createElement('div'),
        msaaSamples: 4,
      })

      if (disposed) { viewer.destroy(); return }
      viewerRef.current = viewer
      setViewer(viewer)

      // Terrain
      try {
        viewer.scene.terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1)
      } catch (e) { console.warn('Terrain failed:', e) }
      if (disposed) return

      // Buildings (try Google Photorealistic first, fall back to OSM)
      let buildingsLoaded = false
      if (googleMapsKey) {
        try {
          const t = await Cesium.Cesium3DTileset.fromUrl(
            `https://tile.googleapis.com/v1/3dtiles/root.json?key=${googleMapsKey}`
          )
          viewer.scene.primitives.add(t)
          buildingsLoaded = true
        } catch (e) { console.warn('Google 3D Tiles failed, falling back to OSM:', e) }
      }
      if (!buildingsLoaded) {
        try {
          const osm = await Cesium.Cesium3DTileset.fromIonAssetId(96188)
          viewer.scene.primitives.add(osm)
        } catch (e) { console.warn('OSM Buildings also failed:', e) }
      }
      if (disposed) return

      // Scene config
      const scene = viewer.scene
      scene.globe.enableLighting = true
      scene.fog.enabled = true
      scene.fog.density = 2.0e-4
      scene.globe.showGroundAtmosphere = true
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = true
      scene.globe.baseColor = Cesium.Color.fromCssColorString('#0a0c12')
      scene.globe.depthTestAgainstTerrain = true

      // Time
      viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date())
      viewer.clock.shouldAnimate = true
      viewer.clock.multiplier = 1

      // Initial camera
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height),
        orientation: {
          heading: Cesium.Math.toRadians(HOME.heading),
          pitch: Cesium.Math.toRadians(HOME.pitch),
          roll: 0,
        },
      })

      // Camera status sync + altitude clamp
      scene.postRender.addEventListener(() => {
        const c = viewer.camera.positionCartographic
        if (c) {
          // Enforce max altitude
          if (c.height > MAX_ALTITUDE) {
            viewer.camera.setView({
              destination: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, MAX_ALTITUDE),
              orientation: {
                heading: viewer.camera.heading,
                pitch: viewer.camera.pitch,
                roll: viewer.camera.roll,
              },
            })
          }
          setStatus({
            lat: Cesium.Math.toDegrees(c.latitude),
            lon: Cesium.Math.toDegrees(c.longitude),
            alt: c.height,
            heading: Cesium.Math.toDegrees(viewer.camera.heading),
          })
        }
      })

      // Keyboard fly controls
      setupKeyboard(viewer)

      // Gamepad support
      setupGamepad(viewer)

      setLoading(false)
    }

    init()

    return () => {
      disposed = true
      setViewer(null)
      if (viewerRef.current) {
        viewerRef.current.destroy()
        viewerRef.current = null
      }
    }
  }, [cesiumToken, googleMapsKey])

  const altStr = status.alt > 100_000
    ? (status.alt / 1000).toFixed(0) + ' km'
    : status.alt > 1000
      ? (status.alt / 1000).toFixed(1) + ' km'
      : status.alt.toFixed(0) + ' m'

  return (
    <>
      <div ref={containerRef} style={{ position: 'fixed', inset: 0 }} />

      {loading && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-deep)',
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 48, height: 48, margin: '0 auto 16px',
              border: '3px solid var(--border)', borderTopColor: 'var(--accent)',
              borderRadius: '50%', animation: 'spin 1s linear infinite',
            }} />
            <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Loading Earth...</div>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        </div>
      )}

      {!loading && (
        <div style={{
          position: 'fixed', bottom: 16, left: 16, zIndex: 10,
          padding: '8px 14px',
          background: 'var(--bg-panel)', backdropFilter: 'blur(var(--blur))',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          fontFamily: 'var(--mono, monospace)', fontSize: 12,
          color: 'var(--text-secondary)',
          display: 'flex', gap: 20,
          pointerEvents: 'none',
        }}>
          <span><Label>Lat</Label> {status.lat.toFixed(4)}°</span>
          <span><Label>Lon</Label> {status.lon.toFixed(4)}°</span>
          <span><Label>Alt</Label> {altStr}</span>
          <span><Label>Hdg</Label> {status.heading.toFixed(0)}°</span>
        </div>
      )}
    </>
  )
}

function Label({ children }: { children: string }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 500, textTransform: 'uppercase',
      letterSpacing: '0.06em', color: 'var(--text-muted)', marginRight: 4,
    }}>
      {children}
    </span>
  )
}

// ============================================
// Keyboard shortcuts (non-movement)
// Movement is handled by mouse/trackpad via Cesium's ScreenSpaceCameraController.
// ============================================

function setupKeyboard(viewer: Cesium.Viewer) {
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return

    // R = reset view
    if (e.key.toLowerCase() === 'r') {
      playRumble()
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height),
        orientation: {
          heading: Cesium.Math.toRadians(HOME.heading),
          pitch: Cesium.Math.toRadians(HOME.pitch),
          roll: 0,
        },
        duration: 2.0,
      })
    }
  })
}

// ============================================
// Gamepad: left stick = move, right stick = look
// ============================================

function setupGamepad(viewer: Cesium.Viewer) {
  const deadzone = 0.15

  function applyDeadzone(val: number): number {
    return Math.abs(val) < deadzone ? 0 : val
  }

  viewer.clock.onTick.addEventListener(() => {
    const gamepads = navigator.getGamepads()
    if (!gamepads) return

    for (const gp of gamepads) {
      if (!gp) continue

      const camera = viewer.camera
      const height = camera.positionCartographic.height
      const moveRate = height / 30
      const lookRate = 0.03

      // Left stick: move
      const lx = applyDeadzone(gp.axes[0] || 0)
      const ly = applyDeadzone(gp.axes[1] || 0)
      if (lx !== 0) camera.moveRight(lx * moveRate)
      if (ly !== 0) camera.moveForward(-ly * moveRate)

      // Right stick: look
      const rx = applyDeadzone(gp.axes[2] || 0)
      const ry = applyDeadzone(gp.axes[3] || 0)
      if (rx !== 0) camera.twistRight(rx * lookRate)
      if (ry !== 0) camera.lookUp(-ry * lookRate)

      // Triggers: altitude
      const lt = gp.buttons[6]?.value || 0  // descend
      const rt = gp.buttons[7]?.value || 0  // ascend
      if (rt > 0.1) camera.moveUp(rt * moveRate)
      if (lt > 0.1) camera.moveDown(lt * moveRate)

      // Only process first connected gamepad
      break
    }
  })
}
