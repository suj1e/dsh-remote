import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

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

console.log(JSON.stringify({
  dshHomeIsolated: true,
  workspaceCreated: true,
  sessionCreated: true,
  readBytesHex: Buffer.from(read.byteParts.get('bytes-0')).toString('hex'),
  uploadSucceeded: uploadResult.ok,
  eventStreamReady: streamResult.firstItemType === 'ready',
  eventStreamCancellationSettled: streamResult.cancellationSettled,
}))
