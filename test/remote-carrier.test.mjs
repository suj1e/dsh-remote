import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import test from 'node:test'
import { DeviceRegistry } from '../dist/access/device-registry.js'
import { Config, createRemoteCarrier } from '../dist/server/remote-carrier.js'

async function setup(t, gateway, configOverrides = {}) {
  const root = new Context()
  const forwarded = []
  const hostFiber = await root.plugin((ctx) => {
    new HostConnectionService(ctx, [], { isAuthenticated: () => true })
    ctx.connection.rpc.intercept('/api', () => true, async (endpoint, payload) => {
      forwarded.push({ endpoint, payload })
      return { ok: true, value: { endpoint, payload } }
    })
    ctx.connection.fetch.register({
      path: '/api/session/uploadFileBinary',
      methods: ['POST'],
      requestBody: 'streaming',
      async fetch(request) {
        const chunks = []
        for await (const chunk of request.body) chunks.push(Buffer.from(chunk))
        return Response.json({
          sessionId: new URL(request.url).searchParams.get('sessionId'),
          bytesHex: Buffer.concat(chunks).toString('hex'),
        })
      },
    })
  })
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-carrier-'))
  const registry = await DeviceRegistry.open(join(directory, 'devices-v1.json'))
  const pairing = registry.openPairingWindow()
  const paired = await registry.pair(pairing.code, 'iPhone')
  if (!paired.ok) assert.fail('test setup could not pair a device')
  const carrier = await createRemoteCarrier({
    config: Config({ bindHost: '127.0.0.1', bindPort: 0, ...configOverrides }),
    registry,
    fetchHandler: root.connection.createSharedFetchHandler('/api'),
    gateway,
    host: {
      identity: { schemaVersion: 1, instanceId: 'd30db0f2-1c20-4629-bc20-0ecde59a65e9' },
      dshVersion: '0.1.7-rc.2-test',
      name: 'test-host',
      platform: 'darwin',
    },
  })

  t.after(async () => {
    await carrier.close()
    await hostFiber.dispose()
    await root.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return { carrier, registry, device: paired.device, token: paired.deviceToken, pairingCode: pairing.code, forwarded }
}

const inertGateway = {
  async invoke() {
    return {
      options: [{ value: 'workspace-write' }],
      defaultOptions: [{ value: 'read-only' }],
      defaultPreset: 'workspace-write',
    }
  },
  wireStream: {
    async open() { return { async *[Symbol.asyncIterator]() {} } },
    failure(error) { return { code: 'test/failure', message: String(error), details: {} } },
  },
}

test('production carrier requires per-device bearer auth and forwards only exact official unary requests', async (t) => {
  const { carrier, registry, device, token, pairingCode, forwarded } = await setup(t, inertGateway)
  const request = {
    type: 'client-request',
    rpcId: 'prod-carrier-001',
    method: 'session/list',
    payload: { args: { _request: {} } },
  }

  assert.equal((await carrier.app.inject({ method: 'GET', url: '/v1/info' })).statusCode, 401)
  assert.equal((await carrier.app.inject({ method: 'POST', url: '/api/session/list', payload: request })).statusCode, 401)
  assert.equal((await carrier.app.inject({
    method: 'POST',
    url: '/api/session/list',
    headers: { authorization: `Bearer ${token}` },
    payload: { ...request, method: 'session/page' },
  })).statusCode, 400)

  const denied = await carrier.app.inject({
    method: 'POST',
    url: '/api/terminal/execute',
    headers: { authorization: `Bearer ${token}` },
    payload: { ...request, method: 'terminal/execute' },
  })
  assert.equal(denied.statusCode, 403)
  assert.equal(forwarded.length, 0)

  const response = await carrier.app.inject({
    method: 'POST',
    url: '/api/session/list',
    headers: { authorization: `Bearer ${token}` },
    payload: request,
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().type, 'server-response')
  assert.equal(response.json().rpcId, request.rpcId)
  assert.equal(forwarded[0].endpoint, 'session/list')
  assert.equal(carrier.metadata(device).host.instanceId, 'd30db0f2-1c20-4629-bc20-0ecde59a65e9')
  const pairedResponse = await carrier.app.inject({
    method: 'POST',
    url: '/v1/pair',
    payload: { code: pairingCode, deviceName: 'iPad' },
  })
  assert.equal(pairedResponse.statusCode, 201)
  assert.equal(pairedResponse.json().device.name, 'iPad')
  assert.match(pairedResponse.json().deviceToken, /^[A-Za-z0-9_-]{43}$/)
  assert.equal((await carrier.app.inject({
    method: 'GET',
    url: '/v1/info',
    headers: { authorization: `Bearer ${token}` },
  })).json().dsh.version, '0.1.7-rc.2-test')

  registry.closePairingWindow()
  assert.equal((await carrier.app.inject({
    method: 'POST',
    url: '/v1/pair',
    payload: { code: pairingCode, deviceName: 'iPad' },
  })).statusCode, 503)
  await registry.revoke(device.id)
  await carrier.closeDevice(device.id)
  assert.equal((await carrier.app.inject({
    method: 'GET',
    url: '/v1/info',
    headers: { authorization: `Bearer ${token}` },
  })).statusCode, 401)
})

test('commands execute is checked against the live official permission catalog', async (t) => {
  const calls = []
  const gateway = {
    ...inertGateway,
    async invoke(request) {
      calls.push(request)
      return inertGateway.invoke()
    },
  }
  const { carrier, token, forwarded } = await setup(t, gateway)
  const invoke = (line) => carrier.app.inject({
    method: 'POST',
    url: '/api/commands/execute',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      type: 'client-request',
      rpcId: `permission-${line}`,
      method: 'commands/execute',
      payload: { args: { agentId: 'agent-1', line, submittedAttachments: [] } },
    },
  })

  assert.equal((await invoke('/permission workspace-write')).statusCode, 200)
  assert.equal((await invoke('/permission unlisted')).statusCode, 403)
  assert.equal((await invoke('/bash whoami')).statusCode, 403)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(({ namespace, method, args }) => namespace === 'permissionPresets' && method === 'catalog' && Object.keys(args).length === 0))
  assert.equal(forwarded.length, 1)
})

test('upload carrier streams raw bytes through the official Fetch route without JSON conversion', async (t) => {
  const { carrier, token } = await setup(t, inertGateway)
  const response = await carrier.app.inject({
    method: 'POST',
    url: '/api/session/uploadFileBinary?sessionId=session-remote&name=fixture.bin',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    },
    payload: Buffer.from([0x00, 0x7f, 0x80, 0xff]),
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { sessionId: 'session-remote', bytesHex: '007f80ff' })

  const rejected = await carrier.app.inject({
    method: 'POST',
    url: '/api/session/uploadFileBinary?sessionId=a&sessionId=b',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    },
    payload: Buffer.from([1]),
  })
  assert.equal(rejected.statusCode, 403)

  const bounded = await setup(t, inertGateway, { maxUploadBytes: 3 })
  const tooLarge = await bounded.carrier.app.inject({
    method: 'POST',
    url: '/api/session/uploadFileBinary?sessionId=session-remote&name=too-large.bin',
    headers: {
      authorization: `Bearer ${bounded.token}`,
      'content-type': 'application/octet-stream',
    },
    payload: Buffer.from([0, 1, 2, 3]),
  })
  assert.equal(tooLarge.statusCode, 413)

  const chunkedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 1]))
      controller.enqueue(new Uint8Array([2, 3]))
      controller.close()
    },
  })
  const chunkedResponse = await fetch(new URL(
    '/api/session/uploadFileBinary?sessionId=session-remote&name=chunked-too-large.bin',
    bounded.carrier.address,
  ), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bounded.token}`,
      'content-type': 'application/octet-stream',
    },
    body: chunkedBody,
    duplex: 'half',
  })
  assert.equal(chunkedResponse.status, 413)
})

test('WebSocket carrier isolates logical stream cancellation and forwards uplink items', async (t) => {
  const signals = new Map()
  const gateway = {
    ...inertGateway,
    wireStream: {
      failure(error) { return { code: 'test/failure', message: String(error), details: {} } },
      async open(endpoint, _payload, uplink, _peer, signal) {
        signals.set(endpoint, signal)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'ready', endpoint }
            if (endpoint === 'session/control') {
              for await (const value of uplink) yield { type: 'uplink', value }
            }
            if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
          },
        }
      },
    },
  }
  const { carrier, token } = await setup(t, gateway)
  const socket = await carrier.app.injectWS('/api/remote.mux', {
    headers: { authorization: `Bearer ${token}` },
  })
  const incoming = []
  let waiter
  socket.on('message', (data) => {
    if (!waiter) {
      incoming.push(data.toString())
      return
    }
    const current = waiter
    waiter = undefined
    clearTimeout(current.timer)
    current.resolve(data.toString())
  })
  const nextFrame = () => {
    if (incoming.length) return Promise.resolve(JSON.parse(incoming.shift()))
    return new Promise((resolve, reject) => {
      waiter = {
        resolve: (data) => resolve(JSON.parse(data)),
        timer: setTimeout(() => {
          waiter = undefined
          reject(new Error('Timed out waiting for Remote mux frame.'))
        }, 3000),
      }
    })
  }
  const send = (value) => socket.send(JSON.stringify(value))

  send({ type: 'open', streamId: 'control-1', endpoint: 'session/control', payload: { args: {} } })
  send({ type: 'open', streamId: 'follow-1', endpoint: 'session/follow', payload: { args: {} } })
  assert.deepEqual((await nextFrame()).value, { type: 'ready', endpoint: 'session/control' })
  assert.deepEqual((await nextFrame()).value, { type: 'ready', endpoint: 'session/follow' })

  send({ type: 'item', streamId: 'control-1', value: { action: 'continue' } })
  const uplink = await nextFrame()
  assert.equal(uplink.streamId, 'control-1')
  assert.deepEqual(uplink.value, { type: 'uplink', value: { action: 'continue' } })

  send({ type: 'cancel', streamId: 'control-1' })
  const deadline = Date.now() + 1000
  while (!signals.get('session/control')?.aborted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(signals.get('session/control')?.aborted, true)
  assert.equal(signals.get('session/follow')?.aborted, false)

  send({ type: 'cancel', streamId: 'follow-1' })
  socket.close(1000, 'test complete')
  await new Promise((resolve) => socket.once('close', resolve))
  // injectWS uses paired in-memory streams; terminate the server-side peer so
  // Fastify teardown does not wait for ws's 30-second close timeout.
  socket.terminate()
})

test('WebSocket carrier replaces an oversized Gateway item with a bounded official failure frame', async (t) => {
  const gateway = {
    ...inertGateway,
    wireStream: {
      failure() { return { code: 'remote/frame-too-large', message: 'Frame exceeded its configured limit', details: {} } },
      async open() {
        return { async *[Symbol.asyncIterator]() { yield { body: 'x'.repeat(2_048) } } }
      },
    },
  }
  const { carrier, token } = await setup(t, gateway, { maxWebSocketFrameBytes: 1024 })
  const socket = await carrier.app.injectWS('/api/remote.mux', {
    headers: { authorization: `Bearer ${token}` },
  })
  const framePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for bounded stream failure.')), 1_000)
    socket.once('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()))
    })
  })
  socket.send(JSON.stringify({ type: 'open', streamId: 'bounded-1', endpoint: 'session/follow', payload: { args: {} } }))
  const frame = await framePromise

  assert.equal(frame.type, 'error')
  assert.equal(frame.streamId, 'bounded-1')
  assert.equal(frame.error.code, 'remote/frame-too-large')
  socket.terminate()
})
