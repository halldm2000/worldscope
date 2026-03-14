import { create } from 'zustand'
import { createChatSlice, type ChatSlice } from './chat'

// Default Cesium Ion token (free tier, 500K monthly tile requests).
// Users can override via VITE_CESIUM_ION_TOKEN env var or the settings command.
const DEFAULT_CESIUM_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwOTRjOThmNy04OTExLTQ1N2MtODA3MS05NWQ3MGIyNDYxMGEiLCJpZCI6MzAwNDM4LCJpYXQiOjE3NDY2NDQ3NjF9.hxqqOJuFRmJS_uSboQp7y051xT1gKpG1uFu70RPuHJQ'

function getInitialCesiumToken(): string {
  // Priority: env var > localStorage > default
  if (import.meta.env.VITE_CESIUM_ION_TOKEN) return import.meta.env.VITE_CESIUM_ION_TOKEN
  try {
    const saved = localStorage.getItem('earthexplorer_cesium_token')
    if (saved) return saved
  } catch {}
  return DEFAULT_CESIUM_TOKEN
}

export interface AppState extends ChatSlice {
  cesiumToken: string
  setCesiumToken: (token: string) => void
}

export const useStore = create<AppState>((set, get, store) => ({
  // App tokens
  cesiumToken: getInitialCesiumToken(),
  setCesiumToken: (token) => {
    try { localStorage.setItem('earthexplorer_cesium_token', token) } catch {}
    set({ cesiumToken: token })
  },

  // Chat slice
  ...createChatSlice(set, get, store),
}))
