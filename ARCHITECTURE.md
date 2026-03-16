# Worldscope Architecture

## What This Is

Worldscope is a runtime for interactive 3D Earth applications. It provides a globe, a conversational command system, a layer registry, base map switching, and a plugin contract. Everything else (weather visualization, earthquake monitoring, hurricane tracking, satellite imagery, ship routes, AI model outputs) lives in separate repos and plugs in at runtime.

The goal: scientists and developers can build "digital twin" applications on top of this platform without touching the core codebase, and without bundling their app code into this repo.

## Core Runtime (this repo)

The core is intentionally small. It handles:

- **3D Globe**: CesiumJS viewer with terrain, buildings (OSM + Google Photorealistic with altitude-based auto-switching), lighting, atmosphere, camera controls, and gamepad support.
- **Conversational interface**: Natural language command system with pattern matching (instant) and Claude fallback (for open-ended questions). Three-state chat panel (minimized, peek, full).
- **Layer system**: Toggleable data overlays supporting GeoJSON vectors, imagery tiles, and 3D tilesets. Lazy-loaded on first use.
- **Base maps**: Switchable imagery styles (satellite, satellite with labels, dark, light, road). Commands: "dark map", "satellite map", etc.
- **Audio feedback**: Procedural Web Audio sounds for navigation, toggling, and data readiness.
- **Plugin API**: The stable contract between core and external plugins (see below).

### Directory Structure

```
src/
  ai/              Command system, router, registry, Claude provider
  app/             App shell, entry point
  audio/           Procedural sound effects
  features/
    layers/        Toggleable data layers (GeoJSON, imagery, tilesets)
  plugin-api/      Plugin contract types and API factory
  scene/           Cesium viewer, engine state, building/base-map management
  store/           Zustand state (tokens, chat)
  ui/              Chat panel
```

## Plugin System

### What is a plugin?

A plugin is an ES module that exports an `EarthPlugin` object. The core hands it an `ExplorerAPI` object during setup, and the plugin registers whatever it needs: layers, commands, data sources, UI panels.

```typescript
import type { EarthPlugin } from 'worldscope/plugin-api'

const plugin: EarthPlugin = {
  id: 'earthquake-monitor',
  name: 'USGS Earthquake Monitor',
  version: '1.0.0',
  apiVersion: '1',

  async setup(api) {
    // Register a real-time point data source
    api.viz.registerPointSource({
      id: 'usgs-earthquakes',
      name: 'USGS Earthquakes',
      realtime: { intervalMs: 60_000 },
      async fetch(req) {
        const res = await fetch('https://earthquake.usgs.gov/...')
        const geojson = await res.json()
        return { points: geojson.features.map(/* ... */) }
      },
    })

    // Register commands
    api.commands.register({
      id: 'earthquake:show',
      name: 'Show earthquakes',
      module: 'earthquake',
      patterns: ['show earthquakes', 'earthquake map', 'seismic activity'],
      // ...
    })
  },

  teardown() { /* cleanup */ }
}

export default plugin
```

### How plugins load

Three mechanisms, from simplest to most sophisticated:

1. **URL import** (zero infrastructure): The core does `await import('https://cdn.example.com/my-plugin/index.js')`. The scientist hosts their plugin anywhere (GitHub Pages, npm CDN, their own server).

2. **Local development**: `await import('./plugins/my-twin/index.ts')`. For active development, clone a plugin template and point the dev server at it.

3. **Plugin manifest** (for discoverability): A JSON file lists available plugins with metadata, URLs, and descriptions. The app reads this and shows a plugin browser. Future work.

### Data-only plugins

Simple data sources don't need code at all. A JSON manifest declares layers and the core handles rendering:

```json
{
  "id": "my-sst-forecast",
  "name": "SST Forecast",
  "apiVersion": "1",
  "layers": [
    {
      "id": "sst-24h",
      "name": "Sea Surface Temperature +24h",
      "kind": "imagery",
      "category": "weather",
      "wms": {
        "url": "https://myserver.edu/wms",
        "layers": "sst_24h",
        "parameters": { "format": "image/png", "transparent": true }
      }
    }
  ]
}
```

## API Stability

The plugin API (`src/plugin-api/types.ts`) is the only thing the core promises to keep stable. Everything else (internal module structure, store shape, router internals) can change freely.

### Stability tiers

| Tier | What | Promise |
|------|------|---------|
| **Stable** | `ExplorerAPI` methods: layers, commands, camera, baseMaps, viz, ui | Breaking changes only with major version bump. One prior major version supported. |
| **Semi-stable** | `api.unsafe.getCesiumViewer()` | May change with notice. For custom rendering that the stable API doesn't cover. |
| **Internal** | Everything in `src/` not exported through `plugin-api/` | No stability promise. Don't import directly from plugins. |

### Versioning

The API carries a version number. When a plugin loads, the core checks compatibility:
- Plugin requires v1, core is on v1: proceed.
- Plugin requires v1, core is on v2 (v1 still supported): proceed with compat shim.
- Plugin requires v1, core is on v3 (v1 dropped): show clear error.

### Testing stability

A small set of "reference plugins" live outside the core repo and run in CI. Every core PR runs them. If they break, the PR is blocked. Candidates for the first reference plugins: earthquake monitor, NASA GIBS imagery, a simple custom-layer example.

## Data Visualization Toolkit

The core provides shared infrastructure that multiple plugin types need. Plugins provide data, the core handles rendering.

### Gridded data (weather, model outputs)

Plugins implement `GriddedDataSource`: given a variable, bounds, and time, return a grid of values. The core renders it with:
- Colormaps (perceptually uniform, configurable, plugins can register custom ones)
- Legends (auto-generated from colormap and value range)
- Time slider (scrub through forecast hours, play animation)
- Comparison mode (side-by-side or overlay two sources)

This is what weather model plugins (StormCast, GFS, ECMWF, Open-Meteo) will use.

### Point data (earthquakes, stations, buoys)

Plugins implement `PointDataSource`: return an array of points with properties. The core renders them as billboard/point entities with data-driven size and color. Supports real-time polling.

### Track data (hurricanes, ships, flights, satellites)

Plugins implement `TrackDataSource`: return named tracks (sequences of timestamped points). The core renders polylines with optional time animation and trail effects.

### Colormaps

Shared colormap library. Default set covers common scientific needs (viridis, inferno, temperature diverging, precipitation sequential). Plugins can register additional colormaps for domain-specific visualization.

## AI Interface

The conversational interface is the primary way users interact with the globe. It understands natural language, executes commands, explains what it did, supports multiple AI providers, and can see the globe via screenshot vision.

### Three-tier routing

Every user input goes through a priority chain. The first tier that handles it wins.

**Tier 1: AI intent classifier (Haiku, ~300ms, ~250 tokens)**
A lightweight, non-streaming call to Claude Haiku that classifies the input as a single command (returns JSON with command ID and params) or "chat" (needs the full conversation path). This replaces the original regex pattern matching with actual language understanding at minimal cost. Simple commands like "go to Berlin", "show borders", or "zoom to 500km" execute directly from the classifier's output without a full chat round-trip.

The classifier receives the current viewer state (camera position, altitude, active layers, base map) so it can handle relative commands like "go up 10m" by computing the target altitude from current state.

Commands marked `chatOnly: true` (all query tools) are excluded from the classifier's command list and always route to Tier 2.

**Tier 2: AI chat with tool use (Sonnet, streaming, 500ms+)**
The full conversational path. Handles compound requests ("fly to Tokyo and show borders"), questions ("what causes hurricanes?"), visual queries ("what am I looking at?"), and anything the classifier defers. The AI receives tool definitions auto-generated from the command registry, can call multiple tools per turn, and loops up to 5 rounds. Supports vision via the screenshot tool (the AI captures and analyzes the CesiumJS canvas).

**Tier 3: Pattern matching fallback (offline only, <1ms)**
Regex-based matching against command patterns. Only fires when no AI provider is available (no API key, offline). Keeps basic commands working without network access. Threshold score >= 0.85.

```
"go to Berlin"
  → Tier 1 (Haiku): {"command":"core:go-to","params":{"place":"berlin"}}
  → Execute directly → fly to Berlin → done (~300ms)

"fly to Tokyo and show borders"
  → Tier 1 (Haiku): {"command":"chat"} (compound request)
  → Tier 2 (Sonnet): calls go-to + layers:toggle in one round
  → Responds: "Flew to Tokyo with borders enabled." (~800ms)

"what am I looking at?"
  → Tier 1: excluded (all query tools are chatOnly)
  → Tier 2 (Sonnet): calls query:screenshot → gets JPEG + position
  → Describes the scene from the image (~2s)

"zoom to 500km" (no AI provider configured)
  → Tier 1/2: skipped (no provider)
  → Tier 3: pattern match → core:zoom-to, altitude=500 → done (<1ms)
```

### Command types

**Action commands** change the globe state: navigation (go-to, zoom-to, zoom-in/out, face-north, reset-view), layers (toggle, show, hide), base maps, buildings, terrain, lighting, time-of-day, audio, fullscreen.

**Query commands** return information without side effects. All are `chatOnly: true` so they route through the AI chat path, which calls them as tools, interprets the results, and gives a conversational answer.

| Command | Returns | Use case |
|---------|---------|----------|
| `query:camera` | Position, altitude, heading, pitch | "Where am I?" |
| `query:layers` | All layers with on/off status | "What layers are available?" |
| `query:scene` | Full state snapshot | "What's showing right now?" |
| `query:screenshot` | JPEG image + position context | "What am I looking at?" (vision) |
| `query:elevation` | Terrain height at lat/lon | "How high is this mountain?" |

### Vision (screenshot tool)

The AI can see the globe. When the user asks a visual question, the chat path calls `query:screenshot`, which captures the CesiumJS canvas as a JPEG (70% quality), returns it as a `ContentBlock[]` with both text context and the image. The Claude provider sends this as a base64 image block in the tool result, and Sonnet describes what it sees.

The `ContentBlock` union type supports text and images throughout the message pipeline:
```typescript
type ContentBlock = { type: 'text'; text: string }
                  | { type: 'image'; mediaType: string; data: string }
```

Command handlers can return `ContentBlock[]` instead of a plain string. The router, providers, and message format all support this. The OpenAI/Ollama provider gracefully degrades (extracts text blocks, skips images).

### State awareness

Both the classifier and chat system prompts include a real-time state snapshot: camera position, altitude, heading, pitch, active layers, base map, and building mode. This lets the AI handle relative commands ("go up 10m", "zoom in closer") and avoid redundant actions (won't toggle a layer that's already on).

### Chat history management

Classifier-handled commands are tagged in the message history. When the chat path (Tier 2) receives history, these tagged exchanges are rewritten as `[Already executed: ...]` context notes. This gives the AI full conversational awareness without re-executing previous commands.

### Multi-provider design

The AI system is provider-agnostic. The `AIProvider` interface defines what any provider must support, and the router handles tool execution regardless of which provider generated the calls.

| Provider | API Format | Tool Use | Notes |
|----------|-----------|----------|-------|
| Anthropic (Claude) | Messages API | `tool_use` blocks | Primary. Haiku for classifier, Sonnet for chat. Vision supported. |
| OpenAI (GPT) | Chat Completions | `function_calling` | Full tool use support. No vision in tool results (text only). |
| Ollama (local) | OpenAI-compatible | `tools` array | Free, private. Limited tool use support depends on model. |
| OpenRouter | OpenAI-compatible | `function_calling` | Multi-model access via single API. |

Provider configuration via chat or env vars:
```
"set provider anthropic sk-ant-..."  → VITE_ANTHROPIC_API_KEY in .env
"set provider ollama"                → Local Ollama (no key needed)
"set provider openrouter sk-or-..."  → OpenRouter multi-model
```

### System prompt design

Built dynamically from: a fixed preamble (role, personality, response style), the current viewer state snapshot, available tool definitions (auto-generated from command registry), and plugin context fragments.

Plugins register system prompt fragments via `api.ai.addSystemContext(...)`. This lets the AI know what's possible without hardcoding plugin knowledge into the core.

### Chat panel

Three-state UI: minimized (command bar), peek (last few messages), full (scrolling sidebar). Messages render with inline markdown (bold, italic, code, code blocks, paragraphs). Tool executions show as `⚡ Tool Name` prefixes. Errors render as red-tinted bubbles. A processing guard prevents overlapping requests.

### Future: MCP server for external chat interfaces

The built-in chat panel works for quick commands, but a laptop user might prefer driving the globe from a more capable external chat interface (Claude Desktop, Claude in Chrome, or any MCP-capable client). The plan is to expose the command registry as a Model Context Protocol (MCP) server running alongside the app. External clients connect via WebSocket, discover available tools, and can call any command. The tool definitions and execution are identical to the internal path. This is planned for a dedicated session.

## Build Order

What to build and in what sequence, prioritized by how much downstream work each piece unblocks.

### Phase 1: Core Runtime (current)
- [x] 3D globe with terrain, buildings, atmosphere
- [x] Conversational command system with pattern matching + Claude
- [x] Layer system (GeoJSON vectors: borders, coastlines, rivers)
- [x] Base map switching (satellite, dark, light, road)
- [x] Plugin API contract (TypeScript interface defined)
- [x] AI interface architecture designed
- [x] **AI tool use: refactor provider interface for streaming tool calls**
- [x] **AI tool use: implement tool execution loop in router**
- [x] **AI tool use: auto-generate tool defs from command registry**
- [x] **OpenAI-compatible provider** (covers OpenAI, Ollama, OpenRouter, any OpenAI-compatible API)
- [x] **Provider switching UI** (set provider command, multi-provider store)
- [x] **Query tools** (camera, layers, scene, elevation, screenshot with vision)
- [x] **AI intent classifier** (Haiku-based, replaces regex as primary router)
- [x] **Chat markdown rendering** (inline bold, italic, code, code blocks)
- [ ] **MCP server** (expose command registry for external chat interfaces like Claude Desktop)
- [ ] Plugin loader (load from URL, validate apiVersion)
- [ ] Data-only plugin loader (JSON manifest)

### Phase 2: Shared Visualization Toolkit
- [ ] Colormap system (built-in library, custom registration)
- [ ] Point renderer (data-driven size, color, labels)
- [ ] Track renderer (polylines, time animation, trail effects)
- [ ] Time slider component (shared across all time-aware plugins)
- [ ] Legend component (auto-generated from colormaps)
- [ ] Grid renderer (for gridded data overlays, GPU-efficient)

### Phase 3: First Plugins (prove the architecture)
- [ ] **Earthquake monitor** (USGS GeoJSON feed, real-time points, simple data model)
- [ ] **NASA GIBS satellite imagery** (hundreds of WMTS layers, zero auth)
- [ ] **Plugin template repo** (starter kit for external developers)

### Phase 4: Complex Plugins
- [ ] **Weather** (multiple providers, high-res grids, forecast time stepping, ensemble viz)
- [ ] **Hurricane tracker** (track data + cone of uncertainty + multiple prediction models)
- [ ] **Ship/flight tracks** (AIS/ADS-B data, real-time streaming)
- [ ] **Satellite visualization** (orbital mechanics, TLE propagation, coverage cones)

### Phase 5: Platform
- [ ] Plugin registry / marketplace
- [ ] Plugin browser UI in the app
- [ ] User preferences (favorite plugins, default layers)
- [ ] Plugin composition (multiple plugins active simultaneously)
