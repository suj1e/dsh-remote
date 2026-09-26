import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseRemoteStreamServerMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol'

const home = process.env.DSH_HOME
assert.ok(home && basename(home).startsWith('dsh-mobile-m0-host.'), 'set DSH_HOME to an isolated dsh-mobile-m0-host.* directory')

const { port } = JSON.parse(await readFile(join(home, 'm0-host-probe.json'), 'utf8'))
const baseURL = `http://127.0.0.1:${port}`
let rpcSequence = 0

async function rpc(endpoint, args) {
  const rpcId = `m0-host-${++rpcSequence}`
  const response = await fetch(`${baseURL}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    }),
  })
  assert.equal(response.status, 200, `${endpoint} HTTP status`)

  let envelope
  let byteParts = new Map()
  if (response.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const parts = await response.formData()
    envelope = JSON.parse(parts.get('metadata'))
    for (const [name, part] of parts.entries()) {
      if (name !== 'metadata' && typeof part !== 'string') {
        byteParts.set(name, new Uint8Array(await part.arrayBuffer()))
      }
    }
  } else {
    envelope = await response.json()
  }

  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, rpcId)
  assert.equal(envelope.result.ok, true, `${endpoint} official Remote result`)
  return { value: envelope.result.value, attachments: envelope.attachments ?? [], byteParts }
}

const workspace = await rpc('workspace/create', {
  request: { path: join(home, 'm0-workspace') },
})
const session = await rpc('session/create', {
  request: { workspaceId: workspace.value.workspace.workspaceId },
})
const read = await rpc('workspaceFiles/readBytes', {
  workspaceFileScopeId: session.value.sessionId,
  path: join(workspace.value.workspace.path, 'fixture.bin'),
  options: { range: { offset: 0, length: 4 } },
})

assert.equal(read.attachments.length, 1)
assert.deepEqual(read.attachments[0], { path: ['data'], codec: 'bytes', part: 'bytes-0' })
assert.deepEqual([...read.byteParts.get('bytes-0')], [0x00, 0x7f, 0x80, 0xff])

const uploadURL = new URL('/api/session/uploadFileBinary', baseURL)
uploadURL.searchParams.set('sessionId', session.value.sessionId)
uploadURL.searchParams.set('name', 'm0-upload.bin')
const upload = await fetch(uploadURL, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: Buffer.from([0xff, 0x80, 0x7f, 0x00]),
})
assert.equal(upload.status, 200, 'official raw upload route HTTP status')
assert.match(upload.headers.get('content-type') ?? '', /^application\/json/)
const uploadResult = await upload.json()
assert.equal(uploadResult.ok, true, 'official raw upload result')

const streamOpen = JSON.parse(await readFile(new URL('./fixtures/contract-v1/stream-open.events.json', import.meta.url), 'utf8'))
streamOpen.streamId = 'm0-host-events'
const stream = await fetch(`${baseURL}/m0/stream/probe`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(streamOpen),
})
assert.equal(stream.status, 200, 'official Gateway stream probe HTTP status')
const streamResult = await stream.json()
assert.equal(streamResult.firstItemType, 'ready', 'official $events ready frame')
assert.equal(streamResult.cancellationSettled, true, 'official $events cancellation settles')

const muxURL = new URL('/api/remote.mux', baseURL)
muxURL.protocol = muxURL.protocol === 'https:' ? 'wss:' : 'ws:'
const muxSocket = new WebSocket(muxURL)
const queuedMessages = []
let messageWaiter
muxSocket.addEventListener('message', ({ data }) => {
  if (!messageWaiter) {
    queuedMessages.push(data)
    return
  }
  const waiter = messageWaiter
  messageWaiter = undefined
  clearTimeout(waiter.timer)
  waiter.resolve(data)
})
muxSocket.addEventListener('close', (event) => {
  if (!messageWaiter) return
  const waiter = messageWaiter
  messageWaiter = undefined
  clearTimeout(waiter.timer)
  waiter.reject(new Error(`WebSocket closed before expected frame (${event.code}).`))
})
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timed out connecting to the isolated WebSocket mux.')), 5_000)
  muxSocket.addEventListener('open', () => {
    clearTimeout(timer)
    resolve()
  }, { once: true })
  muxSocket.addEventListener('error', () => {
    clearTimeout(timer)
    reject(new Error('Could not connect to the isolated WebSocket mux.'))
  }, { once: true })
})

function nextMuxMessage(timeoutMs = 5_000) {
  if (queuedMessages.length > 0) return Promise.resolve(queuedMessages.shift())
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        if (messageWaiter === waiter) messageWaiter = undefined
        resolve(undefined)
      }, timeoutMs),
    }
    messageWaiter = waiter
  })
}

async function openMuxEventStream(streamId) {
  const expectedMessage = nextMuxMessage()
  muxSocket.send(JSON.stringify({ ...streamOpen, streamId }))
  const frame = parseRemoteStreamServerMessage(await expectedMessage)
  assert.equal(frame.type, 'item')
  assert.equal(frame.streamId, streamId)
  assert.equal(frame.value?.type, 'ready')
}

async function waitForMuxStreamIds(expectedIds) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const state = await fetch(`${baseURL}/m0/mux/probe-state`).then((response) => response.json())
    if ([...state.activeStreamIds].sort().join(',') === [...expectedIds].sort().join(',')) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`WebSocket mux did not settle to active streams: ${expectedIds.join(',')}`)
}

await openMuxEventStream('m0-ws-events-1')
await openMuxEventStream('m0-ws-events-2')
muxSocket.send(JSON.stringify({ type: 'cancel', streamId: 'm0-ws-events-1' }))
await waitForMuxStreamIds(['m0-ws-events-2'])
assert.equal(await nextMuxMessage(100), undefined, 'cancelling one logical stream emits no terminal frame or data to its sibling')
muxSocket.send(JSON.stringify({ type: 'cancel', streamId: 'm0-ws-events-2' }))
await waitForMuxStreamIds([])
await new Promise((resolve) => {
  muxSocket.addEventListener('close', resolve, { once: true })
  muxSocket.close(1000, 'M0 probe complete')
})

console.log(JSON.stringify({
  dshHomeIsolated: true,
  workspaceCreated: true,
  sessionCreated: true,
  readBytesHex: Buffer.from(read.byteParts.get('bytes-0')).toString('hex'),
  uploadSucceeded: uploadResult.ok,
  eventStreamReady: streamResult.firstItemType === 'ready',
  eventStreamCancellationSettled: streamResult.cancellationSettled,
  websocketMuxReady: true,
  websocketLogicalStreamIsolation: true,
}))
