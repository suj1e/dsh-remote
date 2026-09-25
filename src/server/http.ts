import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import { WebSocketServer } from 'ws'
import { DeviceStore } from './devices.ts'
import { bearerToken, isLoopback, PairingRateLimiter } from './auth.ts'
import { endpointAllowed, invokeRemote, type GatewayLike } from './rpc.ts'
import { PhoneSocket } from './ws.ts'
import { renderPairPage } from './pair-page.ts'
import type { Config } from '../config.ts'

const MAX_BODY_BYTES = 5 * 1024 * 1024
const PLUGIN_VERSION = '0.1.0'

export interface RemoteServerOptions {
  config: Config
  gateway: GatewayLike
  store: DeviceStore
  log?: (message: string) => void
}

export interface ListenInfo {
  port: number
  addresses: string[]
}

/** LAN-reachable private IPv4 addresses of this host (best effort). */
export function lanAddresses(): string[] {
  const result: string[] = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('127.') || entry.address.startsWith('169.254.')) continue
      result.push(entry.address)
    }
  }
  return result
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * The mobile remote server: one HTTP listener with the management page, the
 * pairing endpoint, the unary RPC proxy, loopback-only admin actions, and the
 * `/v1/ws` upgrade carrying logical Remote streams plus event notifications.
 */
export class RemoteServer {
  readonly sockets = new Set<PhoneSocket>()
  private options: RemoteServerOptions
  private server: Server
  private wss: WebSocketServer
  private limiter = new PairingRateLimiter()
  private listenInfo: ListenInfo | undefined

  constructor(options: RemoteServerOptions) {
    this.options = options
    this.server = createServer((req, res) => void this.handle(req, res))
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
  }

  async listen(): Promise<ListenInfo> {
    const { bind, port } = this.options.config
    const info = await new Promise<ListenInfo>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server.once('error', onError)
      this.server.listen(port, bind, () => {
        this.server.off('error', onError)
        const address = this.server.address()
        resolve({ port: typeof address === 'object' && address ? address.port : port, addresses: lanAddresses() })
      })
    })
    this.listenInfo = info
    return info
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.dispose()
    this.sockets.clear()
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve())
    })
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }

  private info() {
    return {
      plugin: { name: 'dsh-remote', version: PLUGIN_VERSION },
      host: { name: os.hostname(), platform: process.platform },
      server: { port: this.listenInfo?.port ?? this.options.config.port, addresses: lanAddresses() },
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      if (req.method === 'GET' && path === '/') return await this.servePairPage(req, res)
      if (req.method === 'GET' && path === '/v1/info') {
        const device = this.authenticate(req)
        if (!device) return json(res, 401, { error: 'auth/required' })
        return json(res, 200, { ...this.info(), device: { id: device.id, name: device.name } })
      }
      if (req.method === 'POST' && path === '/v1/pair') return await this.servePair(req, res)
      if (req.method === 'POST' && path === '/v1/rpc') return await this.serveRpc(req, res)
      if (path.startsWith('/v1/admin/')) return await this.serveAdmin(req, res, path)
      return json(res, 404, { error: 'not-found' })
    } catch (error) {
      this.options.log?.(`request failed: ${(error as Error).message}`)
      if (!res.headersSent) json(res, 500, { error: 'internal' })
      else res.end()
    }
  }

  private authenticate(req: IncomingMessage) {
    return this.options.store.authenticate(bearerToken(req))
  }

  private async servePairPage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The pairing code and device roster are only for the local operator.
    if (!isLoopback(req)) return json(res, 404, { error: 'not-found' })
    const html = await renderPairPage({
      hostName: os.hostname(),
      port: this.listenInfo?.port ?? this.options.config.port,
      addresses: lanAddresses(),
      pairingCode: this.options.store.pairingCode,
      devices: this.options.store.listDevices(),
    })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  private async servePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? 'unknown'
    const locked = this.limiter.lockedFor(ip)
    if (locked > 0) {
      res.setHeader('retry-after', Math.ceil(locked / 1000))
      return json(res, 429, { error: 'pairing/rate-limited' })
    }
    let body: { code?: unknown; deviceName?: unknown }
    try {
      body = (await readJson(req)) as typeof body
    } catch {
      return json(res, 400, { error: 'pairing/bad-request' })
    }
    if (!this.options.store.verifyPairingCode(body.code)) {
      this.limiter.recordFailure(ip)
      return json(res, 403, { error: 'pairing/invalid-code' })
    }
    this.limiter.recordSuccess(ip)
    const { id, token } = this.options.store.pair(body.deviceName)
    this.options.log?.(`device paired: ${String(body.deviceName ?? 'unnamed')} (${id})`)
    return json(res, 200, { deviceId: id, deviceToken: token, ...this.info() })
  }

  private async serveRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const device = this.authenticate(req)
    if (!device) return json(res, 401, { error: 'auth/required' })
    let body: { endpoint?: unknown; args?: unknown }
    try {
      body = (await readJson(req)) as typeof body
    } catch {
      return json(res, 400, { error: 'rpc/bad-request' })
    }
    if (typeof body.endpoint !== 'string' || typeof body.args !== 'object' || body.args === null) {
      return json(res, 400, { error: 'rpc/bad-request' })
    }
    if (!endpointAllowed(this.options.config.allowedEndpoints, body.endpoint)) {
      return json(res, 403, { error: 'remote/endpoint-forbidden' })
    }
    const result = await invokeRemote(this.options.gateway, body.endpoint, body.args as Record<string, unknown>, undefined)
    return json(res, 200, result)
  }

  private async serveAdmin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!isLoopback(req)) return json(res, 404, { error: 'not-found' })
    if (req.method === 'GET' && path === '/v1/admin/state') {
      return json(res, 200, {
        ...this.info(),
        pairingCode: this.options.store.pairingCode,
        pairingCodeUpdatedAt: this.options.store.pairingCodeUpdatedAt,
        devices: this.options.store.listDevices(),
      })
    }
    if (req.method === 'POST' && path === '/v1/admin/rotate-code') {
      const code = this.options.store.rotatePairingCode()
      this.options.log?.('pairing code rotated')
      return json(res, 200, { pairingCode: code })
    }
    if (req.method === 'POST' && path === '/v1/admin/revoke') {
      let body: { deviceId?: unknown }
      try {
        body = (await readJson(req)) as typeof body
      } catch {
        return json(res, 400, { error: 'admin/bad-request' })
      }
      if (typeof body.deviceId !== 'string' || !this.options.store.revoke(body.deviceId)) {
        return json(res, 404, { error: 'admin/unknown-device' })
      }
      this.options.log?.(`device revoked: ${body.deviceId}`)
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'not-found' })
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/v1/ws') {
      socket.destroy()
      return
    }
    const device = this.authenticate(req)
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const phone = PhoneSocket.attach(ws, {
        gateway: this.options.gateway,
        allowedEndpoints: this.options.config.allowedEndpoints,
        peer: this.options.gateway.operatorPeer(),
        hello: { ...this.info(), device: { id: device.id, name: device.name } },
        log: this.options.log,
      })
      this.sockets.add(phone)
      ws.on('close', () => {
        this.sockets.delete(phone)
      })
    })
  }
}
