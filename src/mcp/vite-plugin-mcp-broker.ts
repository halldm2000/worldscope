/**
 * Vite plugin: MCP WebSocket broker.
 *
 * Runs a WebSocket broker on the Vite dev server that routes messages between
 * MCP server processes (AI clients) and the browser app. This enables multiple
 * AI clients (Claude Code, Claude Desktop, etc.) to share a single browser session.
 *
 * Paths:
 *   /mcp-bridge/browser  — the browser connects here (one connection)
 *   /mcp-bridge/server   — MCP server processes connect here (many connections)
 */

import type { Plugin } from 'vite'
import { WebSocketServer, WebSocket } from 'ws'
import type {
  McpToolDef,
  ServerToBrowserMessage,
  BrowserToServerMessage,
} from './protocol'
import { BROKER_BROWSER_PATH, BROKER_SERVER_PATH } from './protocol'

export function mcpBrokerPlugin(): Plugin {
  return {
    name: 'mcp-broker',
    apply: 'serve', // dev mode only

    configureServer(viteServer) {
      // State
      let browserSocket: WebSocket | null = null
      const serverSockets = new Map<string, WebSocket>()
      const pendingCalls = new Map<string, string>() // callId -> serverId
      let cachedTools: McpToolDef[] = []
      let serverCounter = 0

      // Create a no-server WSS and manually handle upgrades
      const wss = new WebSocketServer({ noServer: true })

      viteServer.httpServer?.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url!, 'http://localhost')

        if (url.pathname === BROKER_BROWSER_PATH) {
          wss.handleUpgrade(request, socket, head, (ws) => {
            handleBrowserConnect(ws)
          })
        } else if (url.pathname === BROKER_SERVER_PATH) {
          wss.handleUpgrade(request, socket, head, (ws) => {
            handleServerConnect(ws)
          })
        }
        // else: let Vite handle it (HMR, etc.)
      })

      function handleBrowserConnect(ws: WebSocket): void {
        // Replace existing browser connection
        if (browserSocket && browserSocket.readyState === WebSocket.OPEN) {
          browserSocket.close()
        }
        browserSocket = ws
        log('Browser connected')

        // Request tool sync
        sendTo(ws, { type: 'sync-request' })

        ws.on('message', (data) => {
          try {
            const msg: BrowserToServerMessage = JSON.parse(data.toString())
            handleBrowserMessage(msg)
          } catch (err) {
            log(`Failed to parse browser message: ${err}`)
          }
        })

        ws.on('close', () => {
          log('Browser disconnected')
          browserSocket = null
          cachedTools = []

          // Reject all pending calls
          for (const [callId, serverId] of pendingCalls) {
            const serverWs = serverSockets.get(serverId)
            if (serverWs && serverWs.readyState === WebSocket.OPEN) {
              sendTo(serverWs, {
                type: 'tool-result',
                callId,
                content: 'Browser disconnected',
                isError: true,
              } as BrowserToServerMessage)
            }
          }
          pendingCalls.clear()
        })
      }

      function handleServerConnect(ws: WebSocket): void {
        const serverId = `srv-${++serverCounter}`
        serverSockets.set(serverId, ws)
        log(`MCP server connected (${serverId}, total: ${serverSockets.size})`)

        // Send cached tools immediately if available
        if (cachedTools.length > 0) {
          sendTo(ws, { type: 'sync-response', tools: cachedTools } as BrowserToServerMessage)
        } else if (browserSocket && browserSocket.readyState === WebSocket.OPEN) {
          // Request fresh sync from browser
          sendTo(browserSocket, { type: 'sync-request' })
        }

        ws.on('message', (data) => {
          try {
            const msg: ServerToBrowserMessage = JSON.parse(data.toString())
            handleServerMessage(serverId, msg)
          } catch (err) {
            log(`Failed to parse server message from ${serverId}: ${err}`)
          }
        })

        ws.on('close', () => {
          serverSockets.delete(serverId)
          log(`MCP server disconnected (${serverId}, remaining: ${serverSockets.size})`)

          // Clean up pending calls from this server
          for (const [callId, sid] of pendingCalls) {
            if (sid === serverId) pendingCalls.delete(callId)
          }
        })
      }

      function handleBrowserMessage(msg: BrowserToServerMessage): void {
        switch (msg.type) {
          case 'sync-response':
          case 'tools-changed':
            cachedTools = msg.tools
            log(`Tools updated: ${cachedTools.length} available`)
            // Broadcast to ALL connected MCP servers
            for (const [, ws] of serverSockets) {
              if (ws.readyState === WebSocket.OPEN) {
                sendTo(ws, msg)
              }
            }
            break

          case 'tool-result': {
            // Route to the specific MCP server that made the call
            const serverId = pendingCalls.get(msg.callId)
            if (serverId) {
              const serverWs = serverSockets.get(serverId)
              if (serverWs && serverWs.readyState === WebSocket.OPEN) {
                sendTo(serverWs, msg)
              }
              pendingCalls.delete(msg.callId)
            } else {
              log(`tool-result for unknown callId: ${msg.callId}`)
            }
            break
          }
        }
      }

      function handleServerMessage(serverId: string, msg: ServerToBrowserMessage): void {
        if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
          // No browser — if it's a tool call, send an error back
          if (msg.type === 'tool-call') {
            const serverWs = serverSockets.get(serverId)
            if (serverWs && serverWs.readyState === WebSocket.OPEN) {
              sendTo(serverWs, {
                type: 'tool-result',
                callId: msg.callId,
                content: 'Worldscope is not connected. Open the app in your browser first.',
                isError: true,
              } as BrowserToServerMessage)
            }
          }
          return
        }

        switch (msg.type) {
          case 'sync-request':
            // Forward to browser
            sendTo(browserSocket, msg)
            break

          case 'tool-call':
            // Track which server made this call, then forward to browser
            pendingCalls.set(msg.callId, serverId)
            sendTo(browserSocket, msg)
            break
        }
      }

      function sendTo(ws: WebSocket, msg: ServerToBrowserMessage | BrowserToServerMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg))
        }
      }

      function log(msg: string): void {
        console.log(`[mcp-broker] ${msg}`)
      }
    },
  }
}
