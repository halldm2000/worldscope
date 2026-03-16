# Project State

## Current Status

Core runtime ~85% complete. MCP server fully operational with dual transport (stdio + HTTP). Navigation commands battle-tested via Claude Code voice sessions. Google Photorealistic 3D Tiles with altitude auto-switching. CesiumJS 1.139, React 18, Zustand, Vite, pnpm.

## Recent Changes

| Date | Change | Files |
|------|--------|-------|
| 2026-03-16 | Add orbit command with auto-cancel on user input | src/scene/engine.ts, src/ai/core-commands.ts |
| 2026-03-16 | Fix look-at heading (was 180° inverted) | src/ai/core-commands.ts |
| 2026-03-16 | Fix zoom-to to use AGL instead of ellipsoid height | src/ai/core-commands.ts |
| 2026-03-16 | Generalize face-north → face with heading support | src/ai/core-commands.ts |
| 2026-03-15 | MCP server: dual transport (stdio + HTTP/SSE) | src/mcp/server.ts |
| 2026-03-15 | Wire MCP bridge into app initialization | src/ai/init.ts |
| 2026-03-15 | Fix Cesium 1.139 CameraFlyToOptions type | src/ai/core-commands.ts |
| 2026-03-15 | Switch to pnpm (Dropbox compat) | package.json, pnpm-lock.yaml |
| 2026-03-15 | Register MCP server with Claude Code | ~/.claude.json |
| 2026-03-13 | Project scaffolded from agent-studio template | All |
| 2026-03-13 | CLAUDE.md customized for CesiumJS + Worldscope | CLAUDE.md |

## MCP Architecture

```
Claude Desktop/Code ──stdio──► MCP Server ──WebSocket──► Browser App
Other AI clients ────HTTP────►     │                       (executes commands,
                                   │                        returns results)
                                   ▼
                              Port 3001: WS bridge to browser
                              Port 3002: HTTP MCP endpoint (when --transport http)
```

**Stdio mode** (default): `pnpm run mcp` or `npx tsx src/mcp/server.ts`
**HTTP mode**: `pnpm run mcp:http` or `npx tsx src/mcp/server.ts --transport http`

Tools are dynamically registered from the browser's command registry. When plugins load/unload, tools update automatically.

## Known Issues

- MCP tool schema caching: new/changed tool params require MCP server restart to take effect
- Prototype single-file HTML (CLAUDE-COWORK/worldscope.html) has features not yet ported to modular structure
- vite-plugin-cesium peer dep warning (wants rollup ^2.25, project uses rollup 4)

## Architecture Notes

CesiumJS as the 3D engine, React for UI shell, Zustand for state. Features (flood sim, fire spread, climate projections, weather overlay, Earth-2 inference) will be self-contained modules in src/features/. The Cesium Viewer is abstracted behind src/scene/engine.ts so features never touch Cesium APIs directly. See agent-studio DECISIONS.md for the engine-agnostic rationale.

## Next Steps

1. Phase 2: Visualization toolkit (colormaps, grid renderer, legends, time slider)
2. Phase 3: Reference plugins (earthquake monitor, NASA GIBS)
3. Fix MCP tool re-registration so schema changes don't require server restart
