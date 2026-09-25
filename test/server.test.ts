import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import WebSocket from 'ws'
import { DeviceStore } from '../src/server/devices.ts'
import { RemoteServer } from '../src/server/http.ts'
import { PairingRateLimiter } from '../src/server/auth.ts'
import type { Config } from '../src/config.ts'
import type { GatewayLike } from '../src/server/rpc.ts'

/** Stub gateway implementing the slice PhoneSocket/invoke rely on. */
function stubGateway(): GatewayLike & { calls: string[] } {
  return {
    calls: [],
    async dispatchRpc(endpoint, payload, signal, peer) {
      this.calls.push(endpoint)
      if (endpoint === 'session/fail') {
        return { ok: false, error: { code: 'stub/failure', message: 'boom', details: { a: 1 } } }
      }
      return { ok: true, value: { endpoint, args: payload.args, signal: typeof signal, peer: typeof peer } }
    },
    wireStream: {
      async *open(endpoint, payload, uplink, peer, signal) {
        assert.ok(endpoint.startsWith('session/') || endpoint === '$events', 'stub only serves allowed endpoints')
        // Echo the opening payload, then relay every uplink item.
        yield { opened: endpoint, payload, peer: typeof peer }
        for await (const item of uplink) {
          if (signal.aborted) return
          yield { echoed: item }
        }
        yield { closed: true }
      },
      failure(error) {
        const code = (error as { code?: string }).code
        return {
          code: typeof code === 'string' ? code : 'remote/internal',
          message: (error as Error).message,
          details: {},
        }
      },
    },
    operatorPeer() {
      return { operator: true }
    },
  }
}

interface Harness {
  server: RemoteServer
  gateway: ReturnType<typeof stubGateway>
  url: string
  token: string
  code: string
  close: () => Promise<void>
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-srv-'))
  const store = new DeviceStore(join(dir, 'devices.json'))
  store.load()
  const gateway = stubGateway()
  const config: Config = {
    enabled: true,
    port: 0,
    bind: '127.0.0.1',
    allowedEndpoints: ['session/*'],
  }
  const server = new RemoteServer({ config, gateway, store })
  const { port } = await server.listen()
  const url = `http://127.0.0.1:${port}`

  // Pair a device through the real endpoint.
  const pair = await fetch(`${url}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: store.pairingCode, deviceName: 'test-phone' }),
  }).then((r) => r.json() as Promise<{ deviceToken: string }>)

  return {
    server,
    gateway,
    url,
    token: pair.deviceToken,
    code: store.pairingCode,
    close: async () => {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('server pairs, authenticates and proxies unary rpc', async () => {
  const h = await startHarness()
  try {
    const unauthorized = await fetch(`${h.url}/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'session/list', args: {} }),
    })
    assert.equal(unauthorized.status, 401)

    const ok = await fetch(`${h.url}/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
      body: JSON.stringify({ endpoint: 'session/list', args: { x: 1 } }),
    }).then((r) => r.json())
    assert.deepEqual(ok, { ok: true, value: { endpoint: 'session/list', args: { x: 1 }, signal: 'undefined', peer: 'undefined' } })

    const failure = await fetch(`${h.url}/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
      body: JSON.stringify({ endpoint: 'session/fail', args: {} }),
    }).then((r) => r.json())
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, 'stub/failure')

    const forbidden = await fetch(`${h.url}/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
      body: JSON.stringify({ endpoint: 'workspace/list', args: {} }),
    })
    assert.equal(forbidden.status, 403)

    assert.deepEqual(h.gateway.calls, ['session/list', 'session/fail'])
  } finally {
    await h.close()
  }
})

test('websocket carries hello, streams, and notifications', async () => {
  const h = await startHarness()
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(h.url).port}/v1/ws`, {
      headers: { authorization: `Bearer ${h.token}` },
    })
    const frames: Array<Record<string, unknown>> = []
    const opened = new Promise<void>((resolve) => {
      ws.on('open', () => resolve())
    })
    ws.on('message', (data) => {
      frames.push(JSON.parse(String(data)))
    })
    await opened

    // hello
    await waitFor(() => frames.length > 0)
    assert.equal(frames[0]!.type, 'hello')
    assert.equal(typeof (frames[0]!.host as { name: string }).name, 'string')

    // open a stream with an uplink
    ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: {} } }))
    ws.send(JSON.stringify({ type: 'item', streamId: 's1', value: 'uplink-1' }))
    ws.send(JSON.stringify({ type: 'end', streamId: 's1' }))
    await waitFor(() => frames.some((f) => f.type === 'end' && f.streamId === 's1'))
    ws.close()

    const items = frames.filter((f) => f.type === 'item' && f.streamId === 's1')
    assert.deepEqual(items.map((f) => f.value), [
      { opened: 'session/follow', payload: { args: {} }, peer: 'object' },
      { echoed: 'uplink-1' },
      { closed: true },
    ])
  } finally {
    await h.close()
  }
})

test('websocket rejects unauthenticated upgrades', async () => {
  const h = await startHarness()
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(h.url).port}/v1/ws`)
    const result = await new Promise<'open' | 'error'>((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('error', () => resolve('error'))
    })
    assert.equal(result, 'error')
  } finally {
    await h.close()
  }
})

test('invalid pairing code is refused and rate limited', async () => {
  const h = await startHarness()
  try {
    const attempt = (code: string) =>
      fetch(`${h.url}/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, deviceName: 'x' }),
      })
    assert.equal((await attempt('000001')).status, 403)
    assert.equal((await attempt('000002')).status, 403)
    assert.equal((await attempt('000003')).status, 403)
    assert.equal((await attempt('000004')).status, 403)
    assert.equal((await attempt('000005')).status, 403)
    // The limiter should now be locked even for the correct code.
    assert.equal((await attempt(h.code)).status, 429)
  } finally {
    await h.close()
  }
})

test('rate limiter window behaviour', () => {
  const limiter = new PairingRateLimiter()
  for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4')
  assert.ok(limiter.lockedFor('1.2.3.4') > 0)
  assert.equal(limiter.lockedFor('5.6.7.8'), 0)
  limiter.recordSuccess('1.2.3.4')
  assert.equal(limiter.lockedFor('1.2.3.4') > 0, false, 'success clears the window')
})

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
