#!/usr/bin/env node
/**
 * MCP Server for Worldscope.
 *
 * Runs as a standalone Node.js process. Communicates with AI clients via
 * MCP protocol and connects to the Vite dev server's WebSocket broker
 * to reach the browser app.
 *
 * Both transports start simultaneously:
 *   - stdio: For Claude Desktop / Claude Code
 *   - HTTP (port 3002): For ChatGPT Desktop, OpenAI, custom agents, etc.
 *
 * Usage:
 *   npx tsx src/mcp/server.ts [--broker-url ws://...] [--http-port 3002]
 *
 * For ChatGPT Desktop, expose the HTTP endpoint via ngrok:
 *   ngrok http 3002
 *   Then add the ngrok HTTPS URL in ChatGPT > Settings > Apps > Add MCP Server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type {
  McpToolDef,
  ServerToBrowserMessage,
  BrowserToServerMessage,
  McpContentBlock,
} from './protocol.js'
import { BROKER_SERVER_PATH, DEFAULT_BROKER_PORT } from './protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── State ──

let brokerSocket: WebSocket | null = null
let currentTools: McpToolDef[] = []
const pendingCalls = new Map<string, {
  resolve: (result: { content: string; blocks?: McpContentBlock[]; isError?: boolean }) => void
  timer: ReturnType<typeof setTimeout>
}>()
let callCounter = 0

const TOOL_CALL_TIMEOUT_MS = 30_000
const DEFAULT_HTTP_PORT = 3002
const TOOLS_CACHE_PATH = join(__dirname, '..', '..', '.mcp-tools-cache.json')
const RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_DELAY_MS = 15_000

// ── Tool cache (so tools are available on startup before broker connects) ──

function loadCachedTools(): McpToolDef[] {
  try {
    const data = readFileSync(TOOLS_CACHE_PATH, 'utf-8')
    const tools = JSON.parse(data) as McpToolDef[]
    log(`Loaded ${tools.length} tools from cache`)
    return tools
  } catch {
    return []
  }
}

function saveCachedTools(tools: McpToolDef[]): void {
  try {
    writeFileSync(TOOLS_CACHE_PATH, JSON.stringify(tools, null, 2))
    log(`Saved ${tools.length} tools to cache`)
  } catch (err) {
    log(`Failed to save tool cache: ${err}`)
  }
}

// ── CLI args ──

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const brokerPort = parseInt(get('--broker-port') || String(DEFAULT_BROKER_PORT), 10)
  const brokerUrl = get('--broker-url') || `ws://localhost:${brokerPort}${BROKER_SERVER_PATH}`
  return {
    brokerUrl,
    httpPort: parseInt(get('--http-port') || String(DEFAULT_HTTP_PORT), 10),
  }
}

// ── Broker connection (WebSocket client) ──

let currentDelay = RECONNECT_DELAY_MS
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function connectToBroker(url: string): void {
  try {
    brokerSocket = new WebSocket(url)
  } catch {
    scheduleReconnect(url)
    return
  }

  brokerSocket.on('open', () => {
    log(`Connected to broker at ${url}`)
    currentDelay = RECONNECT_DELAY_MS

    // Request tool sync
    sendBroker({ type: 'sync-request' })
  })

  brokerSocket.on('message', (data) => {
    try {
      const msg: BrowserToServerMessage = JSON.parse(data.toString())
      handleBrokerMessage(msg)
    } catch (err) {
      log(`Failed to parse broker message: ${err}`)
    }
  })

  brokerSocket.on('close', () => {
    log('Disconnected from broker')
    brokerSocket = null
    scheduleReconnect(url)
  })

  brokerSocket.on('error', () => {
    // 'close' fires after this
  })
}

function scheduleReconnect(url: string): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectToBroker(url)
  }, currentDelay)
  currentDelay = Math.min(currentDelay * 1.5, MAX_RECONNECT_DELAY_MS)
}

function handleBrokerMessage(msg: BrowserToServerMessage): void {
  switch (msg.type) {
    case 'sync-response':
    case 'tools-changed':
      currentTools = msg.tools
      log(`Tools updated: ${currentTools.length} available`)
      saveCachedTools(currentTools)
      refreshMcpTools()
      break

    case 'tool-result': {
      const pending = pendingCalls.get(msg.callId)
      if (pending) {
        clearTimeout(pending.timer)
        pending.resolve({ content: msg.content, blocks: msg.blocks, isError: msg.isError })
        pendingCalls.delete(msg.callId)
      }
      break
    }
  }
}

// ── Tool call forwarding ──

function callBrowserTool(
  commandId: string,
  params: Record<string, unknown>,
): Promise<{ content: string; blocks?: McpContentBlock[]; isError?: boolean }> {
  return new Promise((resolve) => {
    if (!brokerSocket || brokerSocket.readyState !== WebSocket.OPEN) {
      resolve({
        content: 'Worldscope is not connected. Make sure the dev server is running (pnpm dev).',
        isError: true,
      })
      return
    }

    const callId = `mcp-${++callCounter}-${Date.now()}`
    const timer = setTimeout(() => {
      pendingCalls.delete(callId)
      resolve({ content: 'Tool call timed out (30s)', isError: true })
    }, TOOL_CALL_TIMEOUT_MS)

    pendingCalls.set(callId, { resolve, timer })

    sendBroker({
      type: 'tool-call',
      callId,
      commandId,
      params,
    })
  })
}

// ── MCP server ──

const mcpServer = new McpServer({
  name: 'worldscope',
  version: '1.0.0',
})

// Track registered tool names to avoid duplicates (SDK has no unregister)
const registeredToolNames = new Set<string>()

function refreshMcpTools(): void {
  for (const tool of currentTools) {
    if (registeredToolNames.has(tool.name)) continue
    registeredToolNames.add(tool.name)

    // Build a Zod schema from the tool's parameter definition
    const shape: Record<string, z.ZodTypeAny> = {}
    const props = tool.parameters.properties
    const required = new Set(tool.parameters.required || [])

    for (const [key, param] of Object.entries(props)) {
      let field: z.ZodTypeAny
      if (param.enum) {
        field = z.enum(param.enum as [string, ...string[]])
      } else if (param.type === 'number') {
        field = z.number()
      } else if (param.type === 'boolean') {
        field = z.boolean()
      } else {
        field = z.string()
      }
      if (param.description) {
        field = field.describe(param.description)
      }
      if (!required.has(key)) {
        field = field.optional()
      }
      shape[key] = field
    }

    const commandId = tool.commandId

    mcpServer.tool(
      tool.name,
      tool.description,
      shape,
      async (params) => {
        const result = await callBrowserTool(commandId, params)
        return {
          content: buildMcpContent(result),
          isError: result.isError,
        }
      },
    )
  }
}

/** Convert browser result (with optional image blocks) to MCP content array */
function buildMcpContent(result: { content: string; blocks?: McpContentBlock[] }) {
  if (!result.blocks || result.blocks.length === 0) {
    return [{ type: 'text' as const, text: result.content }]
  }
  return result.blocks.map(block => {
    if (block.type === 'image' && block.data) {
      return {
        type: 'image' as const,
        data: block.data,
        mimeType: block.mediaType || 'image/jpeg',
      }
    }
    return { type: 'text' as const, text: block.text || '' }
  })
}

// Register a status resource so clients can check connection state
mcpServer.resource(
  'status',
  'worldscope://status',
  async () => ({
    contents: [{
      uri: 'worldscope://status',
      text: JSON.stringify({
        brokerConnected: brokerSocket?.readyState === WebSocket.OPEN,
        toolCount: currentTools.length,
        tools: currentTools.map(t => t.name),
      }, null, 2),
      mimeType: 'application/json',
    }],
  }),
)

// ── Setup tools (server-side, no browser needed) ──

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const SERVER_SCRIPT = join(PROJECT_ROOT, 'src', 'mcp', 'server.ts')

/** Read a JSON file, returning an empty object if missing or malformed */
function readJsonFile(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

/** Write JSON to a file, creating parent directories if needed */
function writeJsonFile(path: string, data: Record<string, any>): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

/** Check if worldscope is already configured in an mcpServers block */
function hasWorldscope(config: Record<string, any>): boolean {
  return !!config?.mcpServers?.worldscope
}

registerSetupTools(mcpServer)

// ── Transport: stdio ──

async function startStdio(): Promise<void> {
  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
  log('MCP server started (stdio transport)')
}

// ── Transport: HTTP (Streamable HTTP) ──

async function startHttp(httpPort: number): Promise<void> {
  const sessions = new Map<string, StreamableHTTPServerTransport>()

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${httpPort}`)

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id')
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        brokerConnected: brokerSocket?.readyState === WebSocket.OPEN,
        toolCount: currentTools.length,
      }))
      return
    }

    if (url.pathname === '/mcp') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined

      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!
        await transport.handleRequest(req, res)
        return
      }

      if (sessionId && !sessions.has(sessionId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Session not found' }))
        return
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      })

      const sessionServer = new McpServer({
        name: 'worldscope',
        version: '1.0.0',
      })

      registerToolsOn(sessionServer)
      registerResourcesOn(sessionServer)
      registerSetupTools(sessionServer)

      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid) sessions.delete(sid)
        log(`HTTP session closed: ${sid}`)
      }

      await sessionServer.connect(transport)
      await transport.handleRequest(req, res)

      const sid = transport.sessionId
      if (sid) {
        sessions.set(sid, transport)
        log(`New HTTP session: ${sid}`)
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found. Use /mcp for MCP protocol, /health for status.' }))
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject)
    httpServer.listen(httpPort, () => {
      log(`HTTP MCP server listening on http://localhost:${httpPort}/mcp`)
      resolve()
    })
  })
}

function registerToolsOn(server: McpServer): void {
  for (const tool of currentTools) {
    const shape: Record<string, z.ZodTypeAny> = {}
    const props = tool.parameters.properties
    const required = new Set(tool.parameters.required || [])

    for (const [key, param] of Object.entries(props)) {
      let field: z.ZodTypeAny
      if (param.enum) {
        field = z.enum(param.enum as [string, ...string[]])
      } else if (param.type === 'number') {
        field = z.number()
      } else if (param.type === 'boolean') {
        field = z.boolean()
      } else {
        field = z.string()
      }
      if (param.description) field = field.describe(param.description)
      if (!required.has(key)) field = field.optional()
      shape[key] = field
    }

    const commandId = tool.commandId

    server.tool(
      tool.name,
      tool.description,
      shape,
      async (params) => {
        const result = await callBrowserTool(commandId, params)
        return {
          content: buildMcpContent(result),
          isError: result.isError,
        }
      },
    )
  }
}

function registerResourcesOn(server: McpServer): void {
  server.resource(
    'status',
    'worldscope://status',
    async () => ({
      contents: [{
        uri: 'worldscope://status',
        text: JSON.stringify({
          brokerConnected: brokerSocket?.readyState === WebSocket.OPEN,
          toolCount: currentTools.length,
          tools: currentTools.map(t => t.name),
        }, null, 2),
        mimeType: 'application/json',
      }],
    }),
  )
}

function registerSetupTools(server: McpServer): void {
  server.tool(
    'setup-claude-code',
    'Configure Worldscope MCP for Claude Code. Creates .mcp.json in the project directory.',
    {},
    async () => {
      const configPath = join(PROJECT_ROOT, '.mcp.json')
      const config = readJsonFile(configPath)
      if (hasWorldscope(config)) {
        return { content: [{ type: 'text', text: `Already configured: ${configPath}` }] }
      }
      if (!config.mcpServers) config.mcpServers = {}
      config.mcpServers.worldscope = { command: 'npx', args: ['tsx', 'src/mcp/server.ts'], cwd: PROJECT_ROOT }
      writeJsonFile(configPath, config)
      return { content: [{ type: 'text', text: `Configured Claude Code MCP at ${configPath}\n\nTo auto-approve tools, run:\n  /allowed-tools mcp__worldscope__*` }] }
    },
  )

  server.tool(
    'setup-claude-desktop',
    'Configure Worldscope MCP for Claude Desktop. Adds the server to claude_desktop_config.json.',
    {},
    async () => {
      const configPath = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      const config = readJsonFile(configPath)
      if (hasWorldscope(config)) {
        return { content: [{ type: 'text', text: `Already configured: ${configPath}\n\nRestart Claude Desktop to pick up any changes.` }] }
      }
      if (!config.mcpServers) config.mcpServers = {}
      config.mcpServers.worldscope = { command: 'npx', args: ['tsx', SERVER_SCRIPT] }
      writeJsonFile(configPath, config)
      return { content: [{ type: 'text', text: `Configured Claude Desktop MCP at ${configPath}\n\nRestart Claude Desktop for the change to take effect.` }] }
    },
  )

  server.tool(
    'setup-cursor',
    'Configure Worldscope MCP for Cursor IDE. Creates .cursor/mcp.json in the project directory.',
    {},
    async () => {
      const configPath = join(PROJECT_ROOT, '.cursor', 'mcp.json')
      const config = readJsonFile(configPath)
      if (hasWorldscope(config)) {
        return { content: [{ type: 'text', text: `Already configured: ${configPath}\n\nOpen the project in Cursor and the MCP server will be available automatically.` }] }
      }
      if (!config.mcpServers) config.mcpServers = {}
      config.mcpServers.worldscope = { command: 'npx', args: ['tsx', 'src/mcp/server.ts'] }
      writeJsonFile(configPath, config)
      return { content: [{ type: 'text', text: `Configured Cursor MCP at ${configPath}\n\nOpen the worldscope project in Cursor — the MCP tools will be available in AI chat.` }] }
    },
  )
}

// ── Helpers ──

function sendBroker(msg: ServerToBrowserMessage): void {
  if (brokerSocket && brokerSocket.readyState === WebSocket.OPEN) {
    brokerSocket.send(JSON.stringify(msg))
  }
}

function log(msg: string): void {
  process.stderr.write(`[worldscope-mcp] ${msg}\n`)
}

// ── Main ──

async function main(): Promise<void> {
  const config = parseArgs()

  // Load cached tools so they're available immediately
  const cached = loadCachedTools()
  if (cached.length > 0) {
    currentTools = cached
    refreshMcpTools()
  }

  // Connect to broker on the Vite dev server
  connectToBroker(config.brokerUrl)

  // Always start stdio (Claude Code, Claude Desktop, Cursor)
  await startStdio()

  // Try to start HTTP too (for ChatGPT, remote clients via tunnel)
  // If the port is already taken (another MCP instance running), just skip it
  try {
    await startHttp(config.httpPort)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      log(`HTTP port ${config.httpPort} already in use, skipping HTTP transport`)
    } else {
      throw err
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[worldscope-mcp] Fatal: ${err}\n`)
  process.exit(1)
})
