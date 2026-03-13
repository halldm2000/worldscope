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
let effectsVolume = 0.3

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext()
    masterGain = audioCtx.createGain()
    masterGain.connect(audioCtx.destination)
    effectsGain = audioCtx.createGain()
    effectsGain.gain.value = effectsVolume
    effectsGain.connect(masterGain)
  }
  // Resume if suspended (browsers require user gesture)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume()
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

// --- Procedural sound effects ---

/** Soft click sound (UI interaction) */
export function playClick(): void {
  const ctx = getCtx()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(800, ctx.currentTime)
  osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.08)

  gain.gain.setValueAtTime(0.15, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08)

  osc.connect(gain)
  gain.connect(getEffectsGain())
  osc.start()
  osc.stop(ctx.currentTime + 0.1)
}

/** Gentle ascending tone (command executed successfully) */
export function playSuccess(): void {
  const ctx = getCtx()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(440, ctx.currentTime)
  osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15)

  gain.gain.setValueAtTime(0.1, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2)

  osc.connect(gain)
  gain.connect(getEffectsGain())
  osc.start()
  osc.stop(ctx.currentTime + 0.25)
}

/** Soft whoosh (camera movement / fly-to) */
export function playWhoosh(): void {
  const ctx = getCtx()

  // Filtered noise for a whoosh effect
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
  gain.gain.setValueAtTime(0.08, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)

  source.connect(filter)
  filter.connect(gain)
  gain.connect(getEffectsGain())
  source.start()
}

/** Subtle ping (data layer loaded, toggle) */
export function playPing(): void {
  const ctx = getCtx()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'triangle'
  osc.frequency.setValueAtTime(1200, ctx.currentTime)
  osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.12)

  gain.gain.setValueAtTime(0.08, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)

  osc.connect(gain)
  gain.connect(getEffectsGain())
  osc.start()
  osc.stop(ctx.currentTime + 0.2)
}

/** Low tone (error or "not found") */
export function playError(): void {
  const ctx = getCtx()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(300, ctx.currentTime)
  osc.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.2)

  gain.gain.setValueAtTime(0.1, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)

  osc.connect(gain)
  gain.connect(getEffectsGain())
  osc.start()
  osc.stop(ctx.currentTime + 0.3)
}
