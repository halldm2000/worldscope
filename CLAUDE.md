# Worldscope

An interactive 3D globe for visualizing and exploring Earth data. Built as a general-purpose platform with a modular app system for simulations (flood, fire, climate projections), weather overlays, and NVIDIA Earth-2 model inference.

This project uses the **agent-studio** multi-agent framework for development. The orchestrator and specialist agents are at `~/Dropbox/WORK_NVIDIA/NV_PROJECTS/agent-studio/`.

## Tech Stack

- **Framework**: React 18+ with TypeScript
- **3D Engine**: CesiumJS (globe, terrain, 3D tiles, geospatial primitives)
- **State**: Zustand with slices pattern (one slice per feature)
- **Build**: Vite with vite-plugin-cesium
- **Styling**: CSS Modules with CSS custom properties for theming
- **Animation**: react-spring (DOM), manual spring physics via Cesium render hooks (3D)
- **Data formats**: NetCDF, GRIB, CSV, GeoJSON (loaded via typed loaders)
- **AI integration**: Streaming API client (backend proxy for API keys)

## Architecture

```
src/
├── app/          # Shell, layout, providers, routing
├── features/     # Self-contained feature modules (one dir per feature)
├── scene/        # CesiumJS viewer, camera, terrain, buildings, atmosphere
├── data/         # Data pipeline (loaders, transforms, cache)
├── ai/           # AI integration (client, streaming)
├── ui/           # Shared UI components (Panel, Slider, ColorBar, Toggle)
├── shared/       # Types, constants, registry, hooks
└── store/        # Zustand store setup
```

Each feature in `features/` has: `index.ts` (public API + registration), `state.ts` (Zustand slice), `panel.tsx` (sidebar UI), `renderer.ts` (Cesium entities/primitives/imagery), `data.ts` (loading), `types.ts`.

Features register via `shared/registry.ts`. Adding a feature never requires editing core files.

## Cesium-Specific Conventions

- The Cesium Viewer lives in `scene/`. All Cesium API access flows through `scene/engine.ts` helpers, not raw Cesium calls scattered through features.
- Features add to the globe via the engine abstraction: `addImageryLayer()`, `addEntity()`, `addPrimitive()`, `addPostProcessStage()`.
- Camera state is written to the Zustand store by the scene module. Features read camera state from the store, never from `viewer.camera` directly.
- The Cesium render loop is managed by `scene/`. Features hook into pre/post render via the store or engine events, never by touching `viewer.scene` directly.

## API Tokens

- **Cesium Ion**: Required. Stored in `.env` as `VITE_CESIUM_ION_TOKEN`. Provides terrain (asset 1), OSM buildings (asset 96188), and imagery.
- **Google Maps**: Optional. Stored in `.env` as `VITE_GOOGLE_MAPS_KEY`. Enables photorealistic 3D tiles (Cesium Ion asset 2275207).

Never commit `.env`. The app shows an onboarding screen if tokens are missing.

## MCP Integration (Important for AI Agents)

This project has an MCP server that lets AI assistants control the 3D globe. If you have `worldscope` MCP tools available, **just use them**. That's it.

- **Do NOT start the dev server.** The user manages it. If tools return "not connected", ask the user to run `pnpm dev` in the project directory.
- **Do NOT use worktrees.** The MCP server must run from the main project directory.
- **Do NOT use preview tools or launch browsers.** The MCP screenshot tool captures the globe directly.
- **Do NOT install dependencies.** The user's machine has everything set up.

The MCP tools handle navigation, screenshots, layer toggling, queries, and more. The connection from your MCP server to the browser is automatic via a WebSocket broker on the Vite dev server.

## Development Conventions

- **Dark mode is the default.** Light mode is the variant.
- **Colormaps must be perceptually uniform.** Viridis is the default. No rainbow/jet.
- **All animations use spring physics**, not CSS easing. Define spring constants, not durations.
- **Camera controls have inertia.** Cesium's default camera controller handles this; don't replace it.
- **Every data display has units and a legend.** No orphaned colors.
- **No secrets in client code.** API tokens are in `.env` (Vite injects them at build time).
- **Frame budget: 16ms.** Nothing blocks Cesium's render loop.

## Quality Standards

See `quality-gates.md` for specific budgets and thresholds.

## Project Status

See `PROJECT_STATE.md` for current status, recent changes, and known issues.
