/**
 * Sound effects engine.
 *
 * Uses Web Audio API for procedural sounds (no audio files needed).
 * Three channels: effects, ambient, music. Each independently controllable.
 * Global mute on M key.
 */

let audioCtx: AudioContext | null = null
let masterGain: GainNode | null = null
let effectsGain: GainNode | null = null
let muted = false
let effectsVolume = 0.6

/**
 * Ensure the AudioContext is created and running.
 * Must be called from a user gesture (click, keydown) for Chrome autoplay policy.
 */
async function ensureCtx(): Promise<AudioContext> {
  if (!audioCtx) {
    audioCtx = new AudioContext()
    masterGain = audioCtx.createGain()
    masterGain.connect(audioCtx.destination)
    effectsGain = audioCtx.createGain()
    effectsGain.gain.value = effectsVolume
    effectsGain.connect(masterGain)
  }

  if (audioCtx.state === 'suspended') {
    await audioCtx.resume()
  }

  return audioCtx
}

/**
 * Synchronous context getter for internal use.
 * Call ensureCtx() first from the user gesture handler to guarantee it's running.
 */
function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext()
    masterGain = audioCtx.createGain()
    masterGain.connect(audioCtx.destination)
    effectsGain = audioCtx.createGain()
    effectsGain.gain.value = effectsVolume
    effectsGain.connect(masterGain)
  }
  return audioCtx
}

function getEffectsGain(): GainNode {
  getCtx()
  return effectsGain!
}

/** Toggle global mute. Returns new muted state. */
export function toggleMute(): boolean {
  muted = !muted
  if (masterGain) {
    masterGain.gain.value = muted ? 0 : 1
  }
  return muted
}

export function isMuted(): boolean {
  return muted
}

export function setEffectsVolume(vol: number): void {
  effectsVolume = Math.max(0, Math.min(1, vol))
  if (effectsGain) {
    effectsGain.gain.value = effectsVolume
  }
}

/**
 * Warm up the audio system. Call this on the first user interaction
 * (click, keydown) to ensure the AudioContext is ready before playing sounds.
 */
export async function warmUp(): Promise<void> {
  await ensureCtx()
}

// --- Procedural sound effects ---

/** Snap sound (command submitted). Short noise burst through a highpass filter. */
export function playSnap(): void {
  const ctx = getCtx()
  if (ctx.state !== 'running') return

  const bufferSize = ctx.sampleRate * 0.03
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.003))
  }

  const source = ctx.createBufferSource()
  source.buffer = buffer

  const filter = ctx.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = 1000

  const gain = ctx.createGain()
  gain.gain.value = 0.5

  source.connect(filter)
  filter.connect(gain)
  gain.connect(getEffectsGain())
  source.start()
}

/** Rising ding (data loaded). Three ascending sine tones in quick succession. */
export function playSuccess(): void {
  const ctx = getCtx()
  if (ctx.state !== 'running') return

  const notes = [400, 500, 630]
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq

    const t = ctx.currentTime + i * 0.08
    gain.gain.setValueAtTime(0, Math.max(0, t - 0.01))
    gain.gain.setValueAtTime(0.2, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)

    osc.connect(gain)
    gain.connect(getEffectsGain())
    osc.start(t)
    osc.stop(t + 0.2)
  })
}

/** Soft whoosh (camera movement / fly-to) */
export function playWhoosh(): void {
  const ctx = getCtx()
  if (ctx.state !== 'running') return

  const bufferSize = ctx.sampleRate * 0.4
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize)
  }

  const source = ctx.createBufferSource()
  source.buffer = buffer

  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(2000, ctx.currentTime)
  filter.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.3)
  filter.Q.value = 1.0

  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.2, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)

  source.connect(filter)
  filter.connect(gain)
  gain.connect(getEffectsGain())
  source.start()
}

/** Thunder rumble (toggle on/off). Short filtered noise burst with fast decay. */
export function playPing(): void {
  const ctx = getCtx()
  if (ctx.state !== 'running') return

  const dur = 0.4
  const bufferSize = ctx.sampleRate * dur
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.08))
  }

  const source = ctx.createBufferSource()
  source.buffer = buffer

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(300, ctx.currentTime)
  filter.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + dur)
  filter.Q.value = 0.3

  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.35, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)

  source.connect(filter)
  filter.connect(gain)
  gain.connect(getEffectsGain())
  source.start()
}

/** Low tone (error or "not found") */
export function playError(): void {
  const ctx = getCtx()
  if (ctx.state !== 'running') return

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(300, ctx.currentTime)
  osc.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.2)

  gain.gain.setValueAtTime(0.25, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28)

  osc.connect(gain)
  gain.connect(getEffectsGain())
  osc.start()
  osc.stop(ctx.currentTime + 0.3)
}

// ============================================
// Flight sound: continuous wind/engine hum
// that reacts to camera velocity in real time.
//
// Architecture:
//   white noise -> bandpass filter -> gain -> effectsGain -> master -> speakers
//   The filter frequency and gain are updated every frame based on speed.
//   Low speed = low frequency rumble, high speed = higher-pitched wind.
// ============================================

let flightNoiseSource: AudioBufferSourceNode | null = null
let flightFilter: BiquadFilterNode | null = null
let flightGain: GainNode | null = null
let flightActive = false

// A second layer: a low sub-bass hum that adds body
let flightHumOsc: OscillatorNode | null = null
let flightHumGain: GainNode | null = null

/**
 * Initialize the flight sound graph. Called once, then updated per-frame.
 * The sound is always "playing" but at zero gain when stationary.
 */
function initFlightSound(): void {
  const ctx = getCtx()
  if (ctx.state !== 'running') return
  if (flightActive) return
  flightActive = true

  // Layer 1: filtered white noise (wind)
  const bufferDuration = 2 // seconds of noise, looped
  const bufferSize = ctx.sampleRate * bufferDuration
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1
  }

  flightNoiseSource = ctx.createBufferSource()
  flightNoiseSource.buffer = buffer
  flightNoiseSource.loop = true

  flightFilter = ctx.createBiquadFilter()
  flightFilter.type = 'lowpass'
  flightFilter.frequency.value = 40 // will be modulated
  flightFilter.Q.value = 0.5

  flightGain = ctx.createGain()
  flightGain.gain.value = 0 // silent until camera moves

  flightNoiseSource.connect(flightFilter)
  flightFilter.connect(flightGain)
  flightGain.connect(getEffectsGain())
  flightNoiseSource.start()

  // Layer 2: sub-bass hum (gives the feeling of "engine" or "mass moving through air")
  flightHumOsc = ctx.createOscillator()
  flightHumOsc.type = 'sine'
  flightHumOsc.frequency.value = 20 // deep sub-bass, will be modulated

  flightHumGain = ctx.createGain()
  flightHumGain.gain.value = 0

  flightHumOsc.connect(flightHumGain)
  flightHumGain.connect(getEffectsGain())
  flightHumOsc.start()
}

/**
 * Update flight sound based on current camera velocity.
 * Call this every frame from the Cesium render loop.
 *
 * @param speed - Normalized speed 0..1 (0 = stationary, 1 = maximum travel speed)
 */
export function updateFlightSound(speed: number): void {
  const ctx = audioCtx
  if (!ctx || ctx.state !== 'running') return

  // Lazy-init the sound graph on first call
  if (!flightActive) {
    initFlightSound()
  }
  if (!flightFilter || !flightGain || !flightHumOsc || !flightHumGain) return

  const t = ctx.currentTime

  // Smoothing: use setTargetAtTime for gentle transitions (time constant = smoothing speed)
  const smoothing = 0.08 // seconds, lower = more responsive

  if (speed < 0.001) {
    // Stationary: fade to silence
    flightGain.gain.setTargetAtTime(0, t, smoothing)
    flightHumGain.gain.setTargetAtTime(0, t, smoothing)
    return
  }

  // Clamp and apply a curve so low speeds are quieter
  const s = Math.min(speed, 1)
  const curve = s * s // quadratic: gentle at low speeds, strong at high

  // Rumble: lowpass filter sweeps from 40Hz (slow) to 150Hz (fast)
  // Deep atmospheric rumble, barely above subwoofer territory
  const filterFreq = 40 + curve * 110
  flightFilter.frequency.setTargetAtTime(filterFreq, t, smoothing)

  // Rumble volume: up to 0.25 at max speed
  const windVol = curve * 0.25
  flightGain.gain.setTargetAtTime(windVol, t, smoothing)

  // Sub-bass hum: frequency from 20Hz (slow) to 50Hz (fast)
  // Below 30Hz is more vibration than tone
  const humFreq = 20 + curve * 30
  flightHumOsc.frequency.setTargetAtTime(humFreq, t, smoothing)

  // Hum volume: up to 0.15 at max speed
  const humVol = curve * 0.15
  flightHumGain.gain.setTargetAtTime(humVol, t, smoothing)
}

/**
 * Tear down the flight sound (if we ever need to clean up).
 */
export function stopFlightSound(): void {
  if (flightNoiseSource) { try { flightNoiseSource.stop() } catch {} }
  if (flightHumOsc) { try { flightHumOsc.stop() } catch {} }
  flightNoiseSource = null
  flightFilter = null
  flightGain = null
  flightHumOsc = null
  flightHumGain = null
  flightActive = false
}
