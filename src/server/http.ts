import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import { WebSocketServer } from 'ws'
import QRCode from 'qrcode'
import { DeviceStore } from './devices.ts'
import { bearerToken, isLoopback, PairingRateLimiter } from './auth.ts'
import { endpointAllowed, invokeRemote, type GatewayLike } from './rpc.ts'
import { PhoneSocket } from './ws.ts'
import type { Config } from '../config.ts'

const MAX_BODY_BYTES = 5 * 1024 * 1024
const PLUGIN_VERSION = '0.1.9'
const ENTRY_ID = 'dsh-remote'

/**
 * Browser origins allowed to call the loopback admin API cross-origin: the
 * DSH web GUI (any loopback port) and the Electron desktop shell. Everything
 * else — including public websites probing localhost — gets no CORS grant.
 */
const ALLOWED_ORIGIN = /^(?:http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?|dsh-app:\/\/app)$/

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || !ALLOWED_ORIGIN.test(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'false',
    vary: 'Origin',
  }
}

function preflight(req: IncomingMessage, res: ServerResponse): void {
  const headers = corsHeaders(req)
  headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
  headers['access-control-allow-headers'] = 'content-type'
  headers['access-control-max-age'] = '600'
  if (req.headers['access-control-request-private-network'] === 'true') {
    headers['access-control-allow-private-network'] = 'true'
  }
  res.writeHead(204, headers)
  res.end()
}

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

/**
 * LAN-reachable private IPv4 addresses of this host (best effort), ordered by
 * likely phone reachability: home/office 192.168 first, then 10.x, then
 * 172.16–31, then anything else (VPN TUN ranges like 198.18.x sort last so
 * the QR code does not encode a tunnel address when a real LAN exists).
 */
export function lanAddresses(): string[] {
  const collect = (accept: (address: string) => boolean): string[] => {
    const result: string[] = []
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family !== 'IPv4' || entry.internal) continue
        if (entry.address.startsWith('127.') || entry.address.startsWith('169.254.')) continue
        if (accept(entry.address)) result.push(entry.address)
      }
    }
    return result
  }
  const firstOctet = (address: string): number => Number(address.split('.')[0])
  return [
    ...collect((a) => a.startsWith('192.168.')),
    ...collect((a) => a.startsWith('10.')),
    ...collect((a) => firstOctet(a) === 172 && Number(a.split('.')[1]) >= 16 && Number(a.split('.')[1]) <= 31),
    ...collect((a) => !a.startsWith('192.168.') && !a.startsWith('10.') && firstOctet(a) !== 172),
  ]
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  })
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
      if (req.method === 'OPTIONS' && path.startsWith('/v1/admin/')) return preflight(req, res)
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

  /** Cache the pairing QR SVG; it only changes when code or address changes. */
  private qrCache: { key: string; svg: string } | undefined

  private async pairingQrSvg(address: string, port: number, code: string): Promise<string> {
    const deepLink = `dsh-remote://pair?host=${encodeURIComponent(address)}&port=${port}&code=${code}`
    const key = deepLink
    if (this.qrCache?.key === key) return this.qrCache.svg
    const svg = await QRCode.toString(deepLink, { type: 'svg', margin: 1, width: 200 })
    this.qrCache = { key, svg }
    return svg
  }

  private async serveAdmin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    // Loopback socket plus a CORS grant only for trusted GUI origins.
    if (!isLoopback(req)) return json(res, 404, { error: 'not-found' })
    const cors = corsHeaders(req)
    if (req.method === 'GET' && path === '/v1/admin/state') {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const port = this.listenInfo?.port ?? this.options.config.port
      const addresses = lanAddresses()
      const code = this.options.store.pairingCode
      // The page picks which NIC the QR should encode; fall back to the
      // first (most likely reachable) address when the query omits one.
      const requested = url.searchParams.get('address')
      const address = addresses.includes(requested ?? '') ? requested! : (addresses[0] ?? '127.0.0.1')
      return json(res, 200, {
        ...this.info(),
        entryId: ENTRY_ID,
        pairingCode: code,
        pairingCodeUpdatedAt: this.options.store.pairingCodeUpdatedAt,
        qrAddress: address,
        deepLink: `dsh-remote://pair?host=${encodeURIComponent(address)}&port=${port}&code=${code}`,
        pairingQrSvg: await this.pairingQrSvg(address, port, code),
        devices: this.options.store.listDevices(),
      }, cors)
    }
    if (req.method === 'POST' && path === '/v1/admin/rotate-code') {
      const code = this.options.store.rotatePairingCode()
      this.options.log?.('pairing code rotated')
      return json(res, 200, { pairingCode: code }, cors)
    }
    if (req.method === 'POST' && path === '/v1/admin/revoke') {
      let body: { deviceId?: unknown }
      try {
        body = (await readJson(req)) as typeof body
      } catch {
        return json(res, 400, { error: 'admin/bad-request' }, cors)
      }
      if (typeof body.deviceId !== 'string' || !this.options.store.revoke(body.deviceId)) {
        return json(res, 404, { error: 'admin/unknown-device' }, cors)
      }
      this.killDeviceSockets(body.deviceId)
      this.options.log?.(`device revoked: ${body.deviceId}`)
      return json(res, 200, { ok: true }, cors)
    }
    return json(res, 404, { error: 'not-found' }, cors)
  }

  /** Disconnect every live connection that spoke for a revoked device. */
  private killDeviceSockets(deviceId: string): void {
    for (const socket of this.sockets) {
      if (socket.deviceId === deviceId) socket.dispose()
    }
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
        deviceId: device.id,
        log: this.options.log,
      })
      this.sockets.add(phone)
      ws.on('close', () => {
        this.sockets.delete(phone)
      })
    })
  }
}
