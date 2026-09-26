import { PassThrough, Readable, Transform } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import z from '@deepseek-ai/schemastery'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import {
  parseRemoteStreamClientMessage,
  REMOTE_STREAM_MUX_PATH,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
import type { WebSocket } from 'ws'
import {
  authorizeFetchRoute,
  authorizeStreamEndpoint,
  authorizeUnaryRequest,
  type PermissionContext,
} from '../access/endpoint-policy.js'
import { DeviceRegistry, sanitizeDeviceName, type RegisteredDevice } from '../access/device-registry.js'
import type { HostIdentity } from '../access/host-identity.js'

interface ContractManifest {
  contractId: string
  endpointPolicy: {
    unary: string[]
    streams: string[]
    fetchRoutes: Array<{ method: string; path: string; contentType: string }>
  }
}

interface PackageManifest {
  name: string
  version: string
}

const contract = JSON.parse(
  readFileSync(new URL('../../contract/contract-v1.json', import.meta.url), 'utf8'),
) as ContractManifest
const pluginManifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageManifest

export const Config = z.object({
  bindHost: z.string().default('0.0.0.0'),
  bindPort: z.natural().max(65535).default(43125),
  advertisedBaseURLs: z.array(z.string()).default([]),
  maxJsonRequestBytes: z.natural().min(1).default(1_048_576),
  maxUploadBytes: z.natural().min(1).default(300 * 1024 * 1024),
  maxWebSocketFrameBytes: z.natural().min(1024).default(262_144),
  maxWebSocketConnections: z.natural().min(1).max(128).default(8),
  maxStreamsPerSocket: z.natural().min(1).max(64).default(16),
  maxSocketBufferedBytes: z.natural().min(65_536).default(2_097_152),
})

export interface RemoteCarrierConfig {
  bindHost: string
  bindPort: number
  advertisedBaseURLs: string[]
  maxJsonRequestBytes: number
  maxUploadBytes: number
  maxWebSocketFrameBytes: number
  maxWebSocketConnections: number
  maxStreamsPerSocket: number
  maxSocketBufferedBytes: number
}

export interface RemoteHostMetadata {
  identity: HostIdentity
  dshVersion: string
  name: string
  platform: DshHostPlatform
}

export type DshHostPlatform = 'darwin' | 'win32' | 'linux'

export interface RemoteCarrierOptions {
  config: RemoteCarrierConfig
  registry: DeviceRegistry
  fetchHandler: ConnectionFetchHandler
  gateway: TypertGateway
  host: RemoteHostMetadata
}

export interface RemoteAccessMetadata {
  accessVersion: 1
  contractId: string
  plugin: { name: string; version: string }
  dsh: { version: string }
  host: { instanceId: string; name: string; platform: DshHostPlatform }
  endpoints: {
    unary: string[]
    streams: string[]
    fetchRoutes: ContractManifest['endpointPolicy']['fetchRoutes']
  }
  transports: { http: true; websocket: true; streamingUpload: true }
  limits: {
    jsonRequestBytes: number
    uploadBytes: number
    websocketFrameBytes: number
    websocketConnections: number
    streamsPerSocket: number
    socketBufferedBytes: number
  }
  server: { addresses: string[] }
}

export interface RemoteCarrier {
  app: FastifyInstance
  address: string
  metadata(device?: RegisteredDevice): RemoteAccessMetadata & { device?: RegisteredDevice }
  close(): Promise<void>
  closeDevice(deviceId: string): void
}

declare module 'fastify' {
  interface FastifyRequest {
    remoteDevice: RegisteredDevice | null
  }
}

type ActiveResource = { cancel: (reason: Error) => void }

class DeviceActivity {
  private readonly resources = new Map<string, Set<ActiveResource>>()

  track(deviceId: string, resource: ActiveResource): () => void {
    let devices = this.resources.get(deviceId)
    if (!devices) {
      devices = new Set()
      this.resources.set(deviceId, devices)
    }
    devices.add(resource)
    return () => {
      devices?.delete(resource)
      if (devices?.size === 0) this.resources.delete(deviceId)
    }
  }

  closeDevice(deviceId: string, reason = new Error('DSH Remote device revoked')): void {
    const devices = this.resources.get(deviceId)
    if (!devices) return
    this.resources.delete(deviceId)
    for (const resource of devices) resource.cancel(reason)
  }

  closeAll(reason = new Error('DSH Remote carrier stopping')): void {
    for (const deviceId of this.resources.keys()) this.closeDevice(deviceId, reason)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateAdvertisedURLs(values: string[]): string[] {
  return values.map((value) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new TypeError('Each advertised DSH Remote address must be an absolute HTTP(S) URL.')
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    ) {
      throw new TypeError('Advertised DSH Remote addresses must be HTTP(S) URLs without credentials, query, or fragment.')
    }
    return url.href.replace(/\/$/u, '')
  })
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header)
  return match?.[1]
}

function requestURL(request: FastifyRequest): URL {
  return new URL(request.raw.url ?? '/', 'http://dsh-remote.invalid')
}

function headerContentType(request: FastifyRequest): string | undefined {
  const value = request.headers['content-type']
  return typeof value === 'string' ? value : undefined
}

class UploadLimitExceeded extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Remote upload exceeded the ${maximumBytes}-byte limit`)
    this.name = 'UploadLimitExceeded'
  }
}

function boundedUploadStream(
  source: Readable,
  maximumBytes: number,
  onLimitExceeded: (error: UploadLimitExceeded) => void,
): Readable {
  let receivedBytes = 0
  const limiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      receivedBytes += Buffer.byteLength(chunk)
      if (receivedBytes > maximumBytes) {
        const error = new UploadLimitExceeded(maximumBytes)
        onLimitExceeded(error)
        source.unpipe(limiter)
        source.pause()
        callback(error)
        return
      }
      callback(null, chunk)
    },
  })
  source.pipe(limiter)
  return limiter
}

function oversizedUploadReply(
  request: FastifyRequest,
  reply: FastifyReply,
  maximumBytes: number,
): FastifyReply {
  reply.header('connection', 'close')
  reply.raw.once('finish', () => request.raw.destroy())
  return reply.code(413).send({ error: 'remote-upload-too-large', maximumBytes })
}

function setFetchResponse(reply: FastifyReply, response: Response): FastifyReply {
  reply.code(response.status)
  for (const [name, value] of response.headers) {
    if (name === 'connection' || name === 'transfer-encoding' || name === 'keep-alive' || name === 'upgrade') continue
    reply.header(name, value)
  }
  if (response.body === null) return reply.send()
  return reply.send(Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>))
}

function permissionValues(value: unknown): Set<string> {
  if (!isRecord(value) || !Array.isArray(value.options) || !Array.isArray(value.defaultOptions)) {
    throw new Error('The Host permission preset catalog is unavailable or has an unexpected shape.')
  }
  const values = new Set<string>()
  for (const entry of [...value.options, ...value.defaultOptions]) {
    if (!isRecord(entry) || typeof entry.value !== 'string') {
      throw new Error('The Host permission preset catalog contains an invalid entry.')
    }
    values.add(entry.value)
  }
  if (typeof value.defaultPreset === 'string') values.add(value.defaultPreset)
  return values
}

function pairError(reply: FastifyReply, reason: 'closed' | 'expired' | 'invalid' | 'locked'): FastifyReply {
  switch (reason) {
    case 'closed': return reply.code(503).send({ error: 'pairing-window-closed' })
    case 'expired': return reply.code(410).send({ error: 'pairing-window-expired' })
    case 'invalid': return reply.code(401).send({ error: 'pairing-code-invalid' })
    case 'locked': return reply.code(429).header('retry-after', '60').send({ error: 'pairing-window-locked' })
  }
}

export async function createRemoteCarrier(options: RemoteCarrierOptions): Promise<RemoteCarrier> {
  const { config, registry, fetchHandler, gateway, host } = options
  const advertisedBaseURLs = validateAdvertisedURLs(config.advertisedBaseURLs)
  const app = Fastify({ logger: false, bodyLimit: config.maxJsonRequestBytes })
  const activity = new DeviceActivity()
  let activeSocketCount = 0
  await app.register(rateLimit, { global: false })
  await app.register(websocket, {
    options: {
      maxPayload: config.maxWebSocketFrameBytes,
      perMessageDeflate: false,
      clientTracking: true,
    },
  })
  app.decorateRequest('remoteDevice', null)
  app.addContentTypeParser('application/octet-stream', (request, payload, done) => {
    done(null, payload)
  })

  app.addHook('onRequest', async (request, reply) => {
    const path = request.raw.url?.split('?', 1)[0] ?? ''
    if (!path.startsWith('/api/') && path !== '/v1/info') return
    const token = bearerToken(request)
    const device = token ? await registry.authenticate(token) : undefined
    if (!device) {
      reply.header('www-authenticate', 'Bearer')
      return reply.code(401).send({ error: 'device-authentication-required' })
    }
    request.remoteDevice = device
  })

  const metadata = (device?: RegisteredDevice): RemoteAccessMetadata & { device?: RegisteredDevice } => ({
    accessVersion: 1,
    contractId: contract.contractId,
    plugin: { name: pluginManifest.name, version: pluginManifest.version },
    dsh: { version: host.dshVersion },
    host: {
      instanceId: host.identity.instanceId,
      name: host.name,
      platform: host.platform,
    },
    endpoints: {
      unary: contract.endpointPolicy.unary,
      streams: contract.endpointPolicy.streams,
      fetchRoutes: contract.endpointPolicy.fetchRoutes,
    },
    transports: { http: true, websocket: true, streamingUpload: true },
    limits: {
      jsonRequestBytes: config.maxJsonRequestBytes,
      uploadBytes: config.maxUploadBytes,
      websocketFrameBytes: config.maxWebSocketFrameBytes,
      websocketConnections: config.maxWebSocketConnections,
      streamsPerSocket: config.maxStreamsPerSocket,
      socketBufferedBytes: config.maxSocketBufferedBytes,
    },
    server: { addresses: advertisedBaseURLs },
    ...(device ? { device } : {}),
  })

  app.post('/v1/pair', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!isRecord(request.body) || typeof request.body.code !== 'string') {
      return reply.code(400).send({ error: 'invalid-pair-request' })
    }
    const name = sanitizeDeviceName(request.body.deviceName)
    if (!name) return reply.code(400).send({ error: 'invalid-device-name' })

    const result = await registry.pair(request.body.code, name)
    if (!result.ok) return pairError(reply, result.reason)
    return reply.code(201).send({ ...metadata(result.device), deviceToken: result.deviceToken })
  })

  app.get('/v1/info', async (request, reply) => {
    return reply.send(metadata(request.remoteDevice ?? undefined))
  })

  app.post('/api/session/uploadFileBinary', {
    bodyLimit: config.maxUploadBytes,
  }, async (request, reply) => {
    const decision = authorizeFetchRoute({
      method: request.method,
      pathAndQuery: request.raw.url ?? '',
      contentType: headerContentType(request),
    })
    if (!decision.allowed) return reply.code(403).send({ error: 'remote-fetch-route-not-allowed' })

    const url = requestURL(request)
    if (fetchHandler.requestBodyMode({ method: request.method, url }) !== 'streaming') {
      return reply.code(500).send({ error: 'host-fetch-route-not-streaming' })
    }

    const device = request.remoteDevice
    if (!device) return reply.code(401).send({ error: 'device-authentication-required' })
    const contentLength = request.headers['content-length']
    if (typeof contentLength === 'string' && Number(contentLength) > config.maxUploadBytes) {
      return oversizedUploadReply(request, reply, config.maxUploadBytes)
    }
    const abort = new AbortController()
    let sizeError: UploadLimitExceeded | undefined
    const abortRequest = () => abort.abort(new Error('Remote upload client disconnected'))
    const abortResponse = () => {
      if (!reply.raw.writableEnded) abortRequest()
    }
    request.raw.once('aborted', abortRequest)
    reply.raw.once('close', abortResponse)
    const untrack = activity.track(device.id, {
      cancel: (reason) => {
        if (!abort.signal.aborted) abort.abort(reason)
        request.raw.destroy()
        reply.raw.destroy()
      },
    })
    try {
      const limitedBody = boundedUploadStream(
        request.body as Readable,
        config.maxUploadBytes,
        (error) => {
          sizeError = error
          abort.abort(error)
        },
      )
      const fetchRequest = new Request(url, {
        method: request.method,
        headers: { 'content-type': headerContentType(request) ?? 'application/octet-stream' },
        body: Readable.toWeb(limitedBody) as unknown as BodyInit,
        signal: abort.signal,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      const response = await fetchHandler.fetch(fetchRequest)
      if (sizeError) {
        return oversizedUploadReply(request, reply, sizeError.maximumBytes)
      }
      return setFetchResponse(reply, response)
    } catch {
      if (sizeError) {
        return oversizedUploadReply(request, reply, sizeError.maximumBytes)
      }
      if (abort.signal.aborted) return reply.raw.destroy()
      return reply.code(502).send({ error: 'host-fetch-route-failed' })
    } finally {
      request.raw.removeListener('aborted', abortRequest)
      reply.raw.removeListener('close', abortResponse)
      untrack()
    }
  })

  app.post('/api/*', async (request, reply) => {
    const url = requestURL(request)
    const envelope = request.body
    if (url.search !== '' || !isRecord(envelope) || envelope.type !== 'client-request' || typeof envelope.method !== 'string') {
      return reply.code(400).send({ error: 'invalid-official-connection-request' })
    }
    if (url.pathname === '/api/session/uploadFileBinary') {
      return reply.code(403).send({ error: 'remote-fetch-route-not-allowed' })
    }
    const permissionContext: PermissionContext = { presetValues: new Set() }
    const pathEndpoint = url.pathname.slice('/api/'.length)
    if (envelope.method !== pathEndpoint) return reply.code(400).send({ error: 'connection-method-path-mismatch' })

    if (pathEndpoint === 'commands/execute') {
      try {
        const catalog = await gateway.invoke({ namespace: 'permissionPresets', method: 'catalog', args: {} })
        permissionContext.presetValues = permissionValues(catalog)
      } catch {
        return reply.code(503).send({ error: 'host-permission-catalog-unavailable' })
      }
    }
    const decision = authorizeUnaryRequest({
      method: request.method,
      path: url.pathname,
      payload: envelope.payload,
      permissionContext,
    })
    if (!decision.allowed) {
      const status = decision.denial === 'method-not-allowed' ? 405 : decision.denial === 'malformed-endpoint' ? 400 : 403
      return reply.code(status).send({ error: 'remote-endpoint-not-allowed' })
    }

    const device = request.remoteDevice
    if (!device) return reply.code(401).send({ error: 'device-authentication-required' })
    const abort = new AbortController()
    const abortRequest = () => abort.abort(new Error('Remote request client disconnected'))
    const abortResponse = () => {
      if (!reply.raw.writableEnded) abortRequest()
    }
    request.raw.once('aborted', abortRequest)
    reply.raw.once('close', abortResponse)
    const untrack = activity.track(device.id, {
      cancel: (reason) => {
        if (!abort.signal.aborted) abort.abort(reason)
        request.raw.destroy()
        reply.raw.destroy()
      },
    })
    try {
      const fetchRequest = new Request(url, {
        method: request.method,
        headers: { 'content-type': headerContentType(request) ?? 'application/json' },
        body: JSON.stringify(envelope),
        signal: abort.signal,
      })
      const response = await fetchHandler.fetch(fetchRequest)
      return setFetchResponse(reply, response)
    } catch {
      if (abort.signal.aborted) return reply.raw.destroy()
      return reply.code(502).send({ error: 'host-connection-failed' })
    } finally {
      request.raw.removeListener('aborted', abortRequest)
      reply.raw.removeListener('close', abortResponse)
      untrack()
    }
  })

  app.get(REMOTE_STREAM_MUX_PATH, { websocket: true }, (socket, request) => {
    const device = request.remoteDevice
    if (!device || activeSocketCount >= config.maxWebSocketConnections) {
      socket.close(1013, 'Remote socket limit reached')
      return
    }
    activeSocketCount += 1
    const streams = new Map<string, {
      abort: AbortController
      uplink: PassThrough
      uplinkValues: AsyncIterable<unknown>
      ended: boolean
      done: Promise<void>
    }>()
    const blockedStreams = new Set<string>()
    let pressureTimer: NodeJS.Timeout | undefined
    let closeTimer: NodeJS.Timeout | undefined
    let closed = false

    const send = (frame: unknown): Promise<void> => {
      let text: string
      try {
        text = JSON.stringify(frame)
      } catch {
        return Promise.reject(new Error('Remote stream frame is not JSON serializable'))
      }
      const bytes = Buffer.byteLength(text)
      if (bytes > config.maxWebSocketFrameBytes) {
        return Promise.reject(new Error('Remote stream frame exceeds the configured frame limit'))
      }
      if (socket.bufferedAmount + bytes > config.maxSocketBufferedBytes) {
        return Promise.reject(new Error('Remote socket downlink buffer limit exceeded'))
      }
      return new Promise((resolve, reject) => {
        if (socket.readyState !== 1) return reject(new Error('Remote WebSocket is closed'))
        socket.send(text, (error) => error ? reject(error) : resolve())
      })
    }

    const stopStream = (streamId: string, reason: Error) => {
      const active = streams.get(streamId)
      if (!active) return
      if (!active.abort.signal.aborted) active.abort.abort(reason)
      active.uplink.destroy()
      blockedStreams.delete(streamId)
      if (blockedStreams.size === 0 && pressureTimer) {
        clearTimeout(pressureTimer)
        pressureTimer = undefined
        socket.resume()
      }
    }

    const closeConnection = (reason: Error) => {
      if (closed) return
      closed = true
      if (pressureTimer) clearTimeout(pressureTimer)
      for (const [streamId] of streams) stopStream(streamId, reason)
      if (socket.readyState === 1) {
        socket.close(1001, 'Remote stream connection ended')
        closeTimer = setTimeout(() => socket.terminate(), 5_000)
        closeTimer.unref()
      }
    }

    const untrack = activity.track(device.id, { cancel: closeConnection })

    const pump = async (streamId: string, endpoint: string, payload: unknown, active: {
      abort: AbortController
      uplink: PassThrough
      uplinkValues: AsyncIterable<unknown>
      ended: boolean
      done: Promise<void>
    }) => {
      try {
        const source = await gateway.wireStream.open(endpoint, payload, active.uplinkValues, undefined, active.abort.signal)
        for await (const value of source) {
          if (active.abort.signal.aborted || closed) break
          await send({ type: 'item', streamId, value })
        }
        if (!active.abort.signal.aborted && !closed) await send({ type: 'end', streamId })
      } catch (error) {
        if (!active.abort.signal.aborted && !closed && socket.readyState === 1) {
          try {
            await send({ type: 'error', streamId, error: gateway.wireStream.failure(error) })
          } catch {
            closeConnection(new Error('Remote stream terminal frame could not be delivered'))
          }
        } else if (!closed && socket.readyState === 1 && error instanceof Error && error.message.includes('buffer limit')) {
          closeConnection(error)
        }
      } finally {
        streams.delete(streamId)
        blockedStreams.delete(streamId)
        active.uplink.destroy()
        if (blockedStreams.size === 0 && pressureTimer) {
          clearTimeout(pressureTimer)
          pressureTimer = undefined
          if (!closed) socket.resume()
        }
      }
    }

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Remote stream frames must be JSON text')
        return
      }
      let message
      try {
        message = parseRemoteStreamClientMessage(data.toString())
      } catch {
        socket.close(1008, 'Invalid Remote stream frame')
        return
      }
      if (message.type === 'open') {
        if (streams.has(message.streamId)) {
          socket.close(1008, 'Duplicate Remote stream ID')
          return
        }
        if (streams.size >= config.maxStreamsPerSocket) {
          socket.close(1013, 'Remote stream limit reached')
          return
        }
        if (!authorizeStreamEndpoint(message.endpoint).allowed) {
          socket.close(1008, 'Remote stream endpoint is not allowed')
          return
        }
        const active = {
          abort: new AbortController(),
          uplink: new PassThrough({ objectMode: true, highWaterMark: 1 }),
          uplinkValues: undefined as unknown as AsyncIterable<unknown>,
          ended: false,
          done: Promise.resolve(),
        }
        active.uplinkValues = (async function* () {
          for await (const frame of active.uplink) yield (frame as { value: unknown }).value
        })()
        streams.set(message.streamId, active)
        active.done = pump(message.streamId, message.endpoint, message.payload, active)
        return
      }

      const active = streams.get(message.streamId)
      if (!active) return
      if (message.type === 'cancel') {
        stopStream(message.streamId, new Error('Remote stream cancelled by device'))
        return
      }
      if (message.type === 'end') {
        if (active.ended) return
        active.ended = true
        active.uplink.end()
        return
      }
      if (message.type === 'item') {
        if (active.ended) {
          socket.close(1008, 'Remote stream item followed uplink end')
          return
        }
        const accepted = active.uplink.write({ value: message.value })
        if (!accepted) {
          blockedStreams.add(message.streamId)
          socket.pause()
          if (!pressureTimer) {
            pressureTimer = setTimeout(() => closeConnection(new Error('Remote stream uplink remained backpressured')), 30_000)
            pressureTimer.unref()
          }
          active.uplink.once('drain', () => {
            blockedStreams.delete(message.streamId)
            if (blockedStreams.size === 0) {
              if (pressureTimer) clearTimeout(pressureTimer)
              pressureTimer = undefined
              if (!closed) socket.resume()
            }
          })
        }
      }
    })

    socket.once('close', () => {
      if (closeTimer) clearTimeout(closeTimer)
      closeConnection(new Error('Remote stream socket closed'))
      activeSocketCount -= 1
      untrack()
    })
    socket.once('error', () => closeConnection(new Error('Remote stream socket failed')))
  })

  let address: string
  try {
    address = await app.listen({ host: config.bindHost, port: config.bindPort })
  } catch (error) {
    activity.closeAll(new Error('DSH Remote carrier failed to start'))
    for (const socket of app.websocketServer.clients) socket.terminate()
    await app.close().catch(() => undefined)
    throw error
  }
  return {
    app,
    address,
    metadata,
    closeDevice: (deviceId) => activity.closeDevice(deviceId),
    close: async () => {
      activity.closeAll()
      for (const socket of app.websocketServer.clients) socket.terminate()
      await app.close()
    },
  }
}

export async function loadHostVersion(installAnchor: string | undefined): Promise<string> {
  if (!installAnchor) throw new Error('DSH profile installAnchor is unavailable; cannot identify the running Host version.')
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(installAnchor, 'utf8'))
  } catch {
    throw new Error('Could not read the official DSH package manifest from profile installAnchor.')
  }
  if (!isRecord(manifest) || manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('DSH profile installAnchor does not identify an official @deepseek-ai/dsh package manifest.')
  }
  return manifest.version
}

export function currentHostName(): string {
  return hostname()
}

export function currentHostPlatform(): DshHostPlatform {
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    return process.platform
  }
  throw new Error(`DSH Remote supports macOS, Windows, and Linux Hosts; found ${process.platform}.`)
}
