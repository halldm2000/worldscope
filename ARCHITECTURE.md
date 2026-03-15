# Earth Explorer Architecture

## What This Is

Earth Explorer is a runtime for interactive 3D Earth applications. It provides a globe, a conversational command system, a layer registry, base map switching, and a plugin contract. Everything else (weather visualization, earthquake monitoring, hurricane tracking, satellite imagery, ship routes, AI model outputs) lives in separate repos and plugs in at runtime.

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
import type { EarthPlugin } from 'earth-explorer/plugin-api'

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

The conversational interface is the primary way users interact with the globe. It needs to be intelligent (understand intent, take action, explain what it did), multi-provider (not locked to one AI vendor), and tool-capable (the AI can execute commands on the globe, not just talk).

### How it works today

```
User types "go to Berlin"
  → Tier 0: Pattern matching (instant, regex against command registry)
  → Match found → execute handler → done

User types "What causes hurricanes?"
  → Tier 0: No match
  → Tier 3: Send to Claude API → stream text response
  → AI talks but cannot act on the globe
```

The pattern matcher handles structured commands well, but the AI fallback is just a chat window. It can't fly the camera, toggle layers, load data, or do anything except talk.

### What we're building

A tool-use loop where the AI can call any registered command, observe the result, call more commands, and then summarize what it did in natural language. The key insight: the command registry already defines every action the app can take, complete with parameter schemas. Those are the tools.

```
User: "Show me earthquake activity near Japan this week, and switch to dark map"
  → Tier 0: No single pattern match
  → Tier 3: Send to AI with tools derived from command registry
  → AI calls: flyTo({ place: "Japan" })
  → AI calls: setBaseMap({ style: "dark" })
  → AI calls: showLayer({ layer: "earthquakes" })
  → Router executes each tool call, returns results
  → AI responds: "I've flown to Japan, switched to dark map, and turned on
    the earthquake layer. You can see several magnitude 4+ events in the
    past week clustered along the Pacific plate boundary."
```

### Multi-provider design

The AI system is not tied to one provider. The `AIProvider` interface defines what any provider must support, and the router handles the tool execution loop regardless of which provider generated the tool calls.

**Supported provider types:**

| Provider | API Format | Tool Use | Latency | Cost |
|----------|-----------|----------|---------|------|
| Anthropic (Claude) | Messages API | `tool_use` blocks | ~500ms | Per-token |
| OpenAI (GPT) | Chat Completions | `function_calling` | ~500ms | Per-token |
| Google (Gemini) | GenerateContent | `functionDeclarations` | ~500ms | Per-token |
| Ollama (local) | Chat API | `tools` array | ~200ms | Free |
| OpenRouter | OpenAI-compatible | `function_calling` | Varies | Per-token |

Each provider speaks its own wire format for tool use, but they all follow the same conceptual loop: (1) send messages with tool definitions, (2) model responds with tool calls, (3) execute tools, (4) send results back, (5) model continues.

**The normalized format** lives in the router. Providers translate between the normalized format and their native API:

```typescript
// What the router sees (provider-agnostic)
interface ToolCall {
  id: string
  name: string                    // maps to command registry ID
  arguments: Record<string, unknown>
}

interface ToolResult {
  id: string
  content: string                 // what the command returned
  isError?: boolean
}

// What each provider implements
interface AIProvider {
  name: string
  available(): Promise<boolean>

  // Chat with tool use. Yields text chunks and tool call requests.
  chat(
    messages: ChatMessage[],
    tools: ToolDef[],
    options?: ChatOptions,
  ): AsyncIterable<StreamEvent>
}

// Stream events (union type)
type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done' }
```

### Tool definitions from command registry

The router auto-generates tool definitions from the command registry. Every registered command becomes a tool the AI can call. Plugins that register commands automatically become AI-callable, no extra work needed.

```typescript
// Command registry entry (already exists)
{
  id: 'core:go-to',
  name: 'Go to location',
  params: [{ name: 'place', type: 'string', required: true }],
  handler: (params) => { /* fly camera */ },
}

// Auto-generated tool definition sent to AI
{
  name: 'core:go-to',
  description: 'Fly the camera to a named location',
  parameters: {
    type: 'object',
    properties: {
      place: { type: 'string', description: 'Location name' }
    },
    required: ['place']
  }
}
```

### The conversation loop

The router manages the full loop. This is provider-agnostic:

```
1. User sends message
2. Router builds: system prompt + conversation history + tool definitions
3. Send to active provider
4. Provider streams back text chunks and/or tool calls
5. For each tool call:
   a. Look up command in registry
   b. Execute handler with provided arguments
   c. Capture result (success message, error, or data)
   d. Add tool result to conversation
6. If there were tool calls, send updated conversation back to provider
   (the model needs to see the results to formulate its response)
7. Repeat 4-6 until the model produces only text (no more tool calls)
8. Stream final text response to the chat panel
```

Most interactions complete in one round (user asks, model calls 1-3 tools, responds). Complex multi-step tasks might take 2-3 rounds.

### System prompt design

The system prompt gives the AI its identity, capabilities, and constraints. It's built dynamically from:

- A fixed preamble (role, personality, response style)
- The current globe state (camera position, active layers, base map)
- Available tools (auto-generated from command registry)
- Plugin context (active plugins contribute their own system prompt fragments)

Plugins can register system prompt fragments via the API:

```typescript
api.ai.addSystemContext(`
  The StormCast plugin is active. It provides 7-day precipitation
  forecasts from NVIDIA's StormCast model. The user can ask about
  weather forecasts for any location.
`)
```

This lets the AI know what's possible without hardcoding plugin knowledge into the core.

### Provider configuration

Users configure providers through the chat interface or environment variables:

```
"set provider openai sk-..."       → OpenAI with API key
"set provider anthropic sk-ant-..." → Anthropic with API key
"set provider ollama"               → Local Ollama (no key needed)
"set provider openrouter sk-or-..." → OpenRouter (multi-model access)
```

The store persists the active provider and key in localStorage. Multiple providers can be configured simultaneously, with a priority order (local first, then cloud).

### What the AI can do

With tool use, the AI becomes the intelligent glue between all the app's capabilities:

**Navigation + knowledge**: "Take me to the deepest point in the ocean" (flies to Challenger Deep, explains what it is)

**Multi-step workflows**: "Compare the terrain around Mount Everest and K2" (flies to Everest, takes note, flies to K2, provides comparison)

**Data exploration**: "Show me where the strongest earthquakes happened this month" (loads earthquake data, filters by magnitude, flies to the cluster, narrates the pattern)

**Layer composition**: "Set up a view for analyzing tropical storm activity" (switches to dark map, shows coastlines, loads hurricane tracks, zooms to Atlantic basin)

**Plugin interaction**: "Run StormCast for the next 48 hours over Europe and show precipitation" (calls plugin's inference API, loads result as imagery layer, enables time slider)

### What the AI should NOT do

The AI enhances interaction but doesn't replace the command system. Direct commands ("go to Berlin", "dark map", "show borders") still go through Tier 0 pattern matching for instant response. The AI is the fallback for ambiguous, conversational, or multi-step requests.

The AI also shouldn't be a bottleneck. If the user knows what command they want, the pattern matcher fires in <1ms. The AI path adds 500ms+ latency. The tiered system preserves instant feedback for known commands while enabling intelligent behavior for everything else.

## Build Order

What to build and in what sequence, prioritized by how much downstream work each piece unblocks.

### Phase 1: Core Runtime (current)
- [x] 3D globe with terrain, buildings, atmosphere
- [x] Conversational command system with pattern matching + Claude
- [x] Layer system (GeoJSON vectors: borders, coastlines, rivers)
- [x] Base map switching (satellite, dark, light, road)
- [x] Plugin API contract (TypeScript interface defined)
- [x] AI interface architecture designed
- [ ] **AI tool use: refactor provider interface for streaming tool calls**
- [ ] **AI tool use: implement tool execution loop in router**
- [ ] **AI tool use: auto-generate tool defs from command registry**
- [ ] **OpenAI-compatible provider** (covers OpenAI, Ollama, OpenRouter, any OpenAI-compatible API)
- [ ] **Provider switching UI** (set provider command, multi-provider store)
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
