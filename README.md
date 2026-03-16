# Worldscope

An interactive 3D globe for visualizing and exploring Earth data. Built on CesiumJS with Google Photorealistic 3D Tiles, AI-powered navigation, and an MCP server for integration with Claude and other AI assistants.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start the dev server
pnpm dev
```

The app opens at `http://localhost:5173`. No API keys are required for basic usage — an embedded Cesium Ion token provides terrain, imagery, and 3D buildings out of the box.

### Optional: API Keys

Copy `.env.example` to `.env` and fill in any keys you want:

| Variable | Purpose |
|----------|---------|
| `VITE_CESIUM_ION_TOKEN` | Override the default Cesium Ion token |
| `VITE_ANTHROPIC_API_KEY` | Enable the built-in AI chat panel (Claude) |

## AI Integration (MCP)

Worldscope includes an MCP (Model Context Protocol) server that lets AI assistants control the globe. This works with Claude Code, Claude Desktop, or any MCP-compatible client.

### With Claude Code

The `.mcp.json` in the project root auto-registers the server. Just start the dev server and open a Claude Code session in this directory — the tools are available immediately.

To auto-approve all Worldscope tools, run:

```
/allowed-tools mcp__worldscope__*
```

Or add it to `.claude/settings.local.json` for persistence:

```json
{
  "permissions": {
    "allow": ["mcp__worldscope__*"]
  }
}
```

### With Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "worldscope": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/path/to/worldscope"
    }
  }
}
```

### HTTP Mode (Other AI Clients)

For non-Claude environments, run the MCP server in HTTP mode:

```bash
pnpm run mcp:http
```

Then POST MCP requests to `http://localhost:3002/mcp`.

### Architecture

```
AI Client ──stdio/HTTP──> MCP Server ──WebSocket──> Browser App
                           (Node.js)                 (executes commands,
                           Port 3001: WS             returns results + screenshots)
                           Port 3002: HTTP
```

Tools are dynamically synced from the browser's command registry. When features load or unload, the MCP tool list updates automatically.

## Available Commands

### Navigation

| Command | Description |
|---------|-------------|
| **go-to** | Fly to a named place or coordinates |
| **zoom-to** | Set camera altitude above ground level (in km) |
| **zoom-in / zoom-out** | Incremental zoom steps |
| **face** | Face a compass direction (north, east, etc.) or numeric heading (0-360) |
| **look-at** | Position camera at a distance from a target, looking toward it |
| **orbit** | Continuously orbit a target point (auto-stops on user input) |
| **reset-view** | Return to the default globe view |

### View Controls

| Command | Description |
|---------|-------------|
| **toggle-buildings** | Switch between OSM and Google Photorealistic 3D buildings |
| **toggle-terrain** | Enable/disable terrain elevation |
| **toggle-lighting** | Enable/disable sun-based lighting |
| **set-time** | Set the time of day (affects lighting and shadows) |
| **base-map** | Switch base imagery (default, satellite, dark, light, road) |
| **list-maps** | List available base map styles |
| **fullscreen** | Toggle fullscreen mode |

### Queries

| Command | Description |
|---------|-------------|
| **screenshot** | Capture a screenshot of the current view |
| **camera** | Get current camera position, heading, and altitude |
| **scene** | Get full scene state (base map, buildings, terrain, layers) |
| **elevation** | Get terrain elevation at a point |
| **layers** | List available data layers and their status |

### Layers

| Command | Description |
|---------|-------------|
| **layers:toggle** | Show/hide a data layer |
| **layers:list** | List all available layers |
| **layers:hide-all** | Hide all active layers |

## Keyboard Controls

| Key | Action |
|-----|--------|
| W / Arrow Up | Move forward |
| S / Arrow Down | Move backward |
| A / Arrow Left | Move left |
| D / Arrow Right | Move right |
| Q | Rotate left |
| E | Rotate right |
| + / = | Zoom in |
| - | Zoom out |

Hold **Shift** for faster movement. Gamepad input is also supported.

## Tech Stack

- **3D Engine**: CesiumJS 1.139 with Google Photorealistic 3D Tiles
- **Framework**: React 18, TypeScript, Vite
- **State**: Zustand with slices pattern
- **AI**: MCP server (stdio + HTTP), built-in Claude chat panel
- **Package Manager**: pnpm

## Project Structure

```
src/
├── app/          # Shell, layout, providers
├── features/     # Self-contained feature modules
├── scene/        # CesiumJS viewer, camera, terrain, buildings
├── data/         # Data pipeline (loaders, transforms)
├── ai/           # AI commands, providers, chat
├── mcp/          # MCP server and browser bridge
├── ui/           # Shared UI components
├── shared/       # Types, constants, registry
└── store/        # Zustand store
```

## License

NVIDIA Proprietary.
