import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import WebSocket from 'ws'
import { parseRemoteStreamServerMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol'

const home = process.env.DSH_HOME
assert.ok(home && basename(home).startsWith('dsh-mobile-m0-host.'), 'set DSH_HOME to an isolated dsh-mobile-m0-host.* directory')

const { port } = JSON.parse(await readFile(join(home, 'm0-host-probe.json'), 'utf8'))
const { remoteAddress, pairingCode } = JSON.parse(await readFile(join(home, 'm0-host-probe.json'), 'utf8'))
const baseURL = `http://127.0.0.1:${port}`
let rpcSequence = 0

const pairResponse = await fetch(`${remoteAddress}/v1/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: pairingCode, deviceName: 'M0 probe iPhone' }),
})
assert.equal(pairResponse.status, 201, 'production dsh-remote pairing status')
const paired = await pairResponse.json()
assert.match(paired.deviceToken, /^[A-Za-z0-9_-]{43}$/)
assert.equal(paired.host.instanceId.length, 36)
assert.equal(paired.dsh.version, '0.1.7-rc.2')
const remoteBaseURL = remoteAddress.replace(/\/$/u, '')
const remoteInfoResponse = await fetch(`${remoteBaseURL}/v1/info`, {
  headers: { authorization: `Bearer ${paired.deviceToken}` },
})
assert.equal(remoteInfoResponse.status, 200, 'production dsh-remote info status')
assert.equal((await remoteInfoResponse.json()).device.id, paired.device.id)

async function remoteRpc(endpoint, args) {
  const rpcId = `m0-remote-${++rpcSequence}`
  const response = await fetch(`${remoteBaseURL}/api/${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.deviceToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    }),
  })
  assert.equal(response.status, 200, `${endpoint} production carrier HTTP status`)
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
  assert.equal(envelope.result.ok, true, `${endpoint} production carrier Remote result`)
  return { value: envelope.result.value, attachments: envelope.attachments ?? [], byteParts }
}

async function startHostQuestion(questionId) {
  const response = await fetch(`${baseURL}/m0/events/question-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      questions: [{
        id: questionId,
        header: 'M0 probe',
        question: 'Choose the isolated probe result.',
        options: [{ label: 'Continue' }, { label: 'Stop' }],
        multiSelect: false,
      }],
    }),
  })
  assert.equal(response.status, 202, 'the official Host Agent accepted a pending user question')
  return response.json()
}

async function readHostQuestion(runId) {
  const response = await fetch(`${baseURL}/m0/events/question-runs/${runId}`)
  if (response.status === 202) return { status: 'pending' }
  assert.equal(response.status, 200)
  return response.json()
}

async function waitForHostQuestion(runId) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const state = await readHostQuestion(runId)
    if (state.status === 'settled') return state
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`official Host question ${runId} did not settle`)
}

async function disposeHostQuestion(runId) {
  const response = await fetch(`${baseURL}/m0/events/question-runs/${runId}`, { method: 'DELETE' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).disposed, true)
}

async function startHostApproval() {
  const response = await fetch(`${baseURL}/m0/events/approval-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 202, 'the official Host ApprovalService accepted an isolated request')
  return response.json()
}

async function readHostApproval(runId) {
  const response = await fetch(`${baseURL}/m0/events/approval-runs/${runId}`)
  if (response.status === 202) return { status: 'pending' }
  assert.equal(response.status, 200)
  return response.json()
}

async function waitForHostApproval(runId) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const state = await readHostApproval(runId)
    if (state.status === 'settled') return state
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`official Host approval ${runId} did not settle`)
}

async function disposeHostApproval(runId) {
  const response = await fetch(`${baseURL}/m0/events/approval-runs/${runId}`, { method: 'DELETE' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).disposed, true)
}

async function submitEventResult(clientId, eventId, outcome) {
  return remoteRpc('$events/result', { clientId, eventId, outcome })
}

const settingsDescription = await remoteRpc('settings/describe', {})
assert.equal(typeof settingsDescription.value.writable, 'boolean')
assert.equal(typeof settingsDescription.value.hasDocument, 'boolean')
assert.ok(Array.isArray(settingsDescription.value.namespaces))
const settingsNamespace = (name) => settingsDescription.value.namespaces.find((namespace) => namespace.ns === name)
const defaultModelSettings = settingsNamespace('agent-default-model')
const permissionSettings = settingsNamespace('permission')
const secretSettings = settingsNamespace('web-search-deepseek')
assert.ok(defaultModelSettings, 'Host exposes its default agent model namespace')
assert.ok(permissionSettings, 'Host exposes its default permission namespace')
assert.equal(defaultModelSettings.applies, 'live')
const modelFields = defaultModelSettings.schema.refs[defaultModelSettings.schema.uid].dict
assert.deepEqual(Object.keys(modelFields).sort(), ['model', 'provider', 'reasoningEffort'])
for (const fieldName of ['provider', 'model']) {
  const field = defaultModelSettings.schema.refs[modelFields[fieldName]]
  assert.equal(field.type, 'string')
  assert.equal(field.meta.required, true)
}
assert.equal(defaultModelSettings.schema.refs[modelFields.reasoningEffort].type, 'string')
assert.equal(defaultModelSettings.schema.refs[modelFields.reasoningEffort].meta.required, undefined)
const permissionFields = permissionSettings.schema.refs[permissionSettings.schema.uid].dict
assert.deepEqual(Object.keys(permissionFields), ['defaultPreset'])
assert.equal(permissionSettings.schema.refs[permissionFields.defaultPreset].type, 'string')
assert.equal(permissionSettings.schema.refs[permissionFields.defaultPreset].meta.required, undefined)
assert.ok(secretSettings?.secrets.length, 'Host schema includes a redacted secret descriptor')
assert.ok(secretSettings.secrets.every((secret) => (
  Object.keys(secret).sort().join(',') === 'path,set' && Array.isArray(secret.path) && typeof secret.set === 'boolean'
)))

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

async function rawHostRpcResult(endpoint, args) {
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
  const envelope = await response.json()
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, rpcId)
  return envelope.result
}

const staleSettingsMutation = await rawHostRpcResult('settings/mutate', {
  ns: defaultModelSettings.ns,
  ops: [],
  expectedRevision: defaultModelSettings.revision + 1,
})
assert.equal(staleSettingsMutation.ok, false, 'Host rejects a stale settings namespace revision')
assert.equal(typeof staleSettingsMutation.error?.code, 'string')
const unchangedSettingsDescription = await remoteRpc('settings/describe', {})
const unchangedModelSettings = unchangedSettingsDescription.value.namespaces.find((namespace) => namespace.ns === defaultModelSettings.ns)
assert.equal(unchangedModelSettings.revision, defaultModelSettings.revision)
assert.deepEqual(unchangedModelSettings.value, defaultModelSettings.value)

const idempotentSettingsMutation = await rawHostRpcResult('settings/mutate', {
  ns: defaultModelSettings.ns,
  ops: [{ op: 'set', path: ['model'], value: defaultModelSettings.value.model }],
  expectedRevision: defaultModelSettings.revision,
})
assert.equal(idempotentSettingsMutation.ok, true, 'Host accepts a valid CAS mutation at the current revision')
assert.equal(idempotentSettingsMutation.value.ns, defaultModelSettings.ns)
assert.deepEqual(idempotentSettingsMutation.value.value, defaultModelSettings.value)
assert.equal(idempotentSettingsMutation.value.revision, defaultModelSettings.revision)
const afterSettingsMutation = await remoteRpc('settings/describe', {})
const resultingModelSettings = afterSettingsMutation.value.namespaces.find((namespace) => namespace.ns === defaultModelSettings.ns)
assert.equal(resultingModelSettings.revision, idempotentSettingsMutation.value.revision)

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

const remoteRead = await remoteRpc('workspaceFiles/readBytes', {
  workspaceFileScopeId: session.value.sessionId,
  path: join(workspace.value.workspace.path, 'fixture.bin'),
  options: { range: { offset: 0, length: 4 } },
})
assert.deepEqual([...remoteRead.byteParts.get('bytes-0')], [0x00, 0x7f, 0x80, 0xff])

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

const remoteUploadURL = new URL('/api/session/uploadFileBinary', remoteBaseURL)
remoteUploadURL.searchParams.set('sessionId', session.value.sessionId)
remoteUploadURL.searchParams.set('name', 'm0-remote-upload.bin')
const remoteUpload = await fetch(remoteUploadURL, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${paired.deviceToken}`,
    'content-type': 'application/octet-stream',
  },
  body: Buffer.from([0xff, 0x80, 0x7f, 0x00]),
})
assert.equal(remoteUpload.status, 200, 'production raw upload carrier HTTP status')
assert.equal((await remoteUpload.json()).ok, true, 'production raw upload carrier Host result')

const remoteMuxURL = new URL('/api/remote.mux', remoteBaseURL)
remoteMuxURL.protocol = remoteMuxURL.protocol === 'https:' ? 'wss:' : 'ws:'
const remoteSocket = new WebSocket(remoteMuxURL, {
  headers: { authorization: `Bearer ${paired.deviceToken}` },
})
const remoteFrames = []
let remoteFrameWaiter
remoteSocket.on('message', (data) => {
  if (!remoteFrameWaiter) {
    remoteFrames.push(data.toString())
    return
  }
  const waiter = remoteFrameWaiter
  remoteFrameWaiter = undefined
  clearTimeout(waiter.timer)
  waiter.resolve(data.toString())
})
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timed out connecting to the production Remote WebSocket carrier.')), 5_000)
  remoteSocket.once('open', () => {
    clearTimeout(timer)
    resolve()
  })
  remoteSocket.once('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
})
function nextRemoteFrame(timeoutMs = 5_000) {
  if (remoteFrames.length) return Promise.resolve(parseRemoteStreamServerMessage(remoteFrames.shift()))
  return new Promise((resolve, reject) => {
    remoteFrameWaiter = {
      resolve: (data) => resolve(parseRemoteStreamServerMessage(data)),
      timer: setTimeout(() => {
        remoteFrameWaiter = undefined
        if (timeoutMs < 1_000) resolve(undefined)
        else reject(new Error('Timed out waiting for the production Remote stream frame.'))
      }, timeoutMs),
    }
  })
}
const ordinaryEventNames = []
async function nextRemoteEventFrameOfType(type) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const frame = await nextRemoteFrame(Math.max(1, deadline - Date.now()))
    if (!frame) continue
    assert.equal(frame.type, 'item', `expected a Remote event item while waiting for ${type}`)
    if (frame.value?.type === 'emit') {
      ordinaryEventNames.push(frame.value.event)
      continue
    }
    if (frame.value?.type === type) return frame
    assert.fail(`unexpected Remote event frame while waiting for ${type}: ${JSON.stringify(frame.value)}`)
  }
  assert.fail(`Timed out waiting for Remote event frame ${type}.`)
}
async function assertWaterfallFixture(value, fixtureName) {
  const normalized = structuredClone(value)
  normalized.eventId = 'event-fixture-1'
  normalized.agentId = 'agent-fixture-1'
  if (normalized.event === 'user-questions/request') {
    normalized.request.questions[0].id = 'question-fixture-1'
  }
  const expected = JSON.parse(await readFile(new URL(`./fixtures/contract-v1/${fixtureName}`, import.meta.url), 'utf8'))
  assert.deepEqual(normalized, expected)
}
const remoteEventsOpen = JSON.parse(await readFile(new URL('./fixtures/contract-v1/stream-open.events.json', import.meta.url), 'utf8'))
async function openRemoteEvents(streamId) {
  const expectedFrame = nextRemoteFrame()
  remoteSocket.send(JSON.stringify({ ...remoteEventsOpen, streamId }))
  const frame = await expectedFrame
  assert.equal(frame.type, 'item')
  assert.equal(frame.streamId, streamId)
  assert.equal(frame.value?.type, 'ready')
  assert.equal(typeof frame.value?.clientId, 'string')
  return frame.value.clientId
}
const workspaceFollowOpen = JSON.parse(await readFile(new URL('./fixtures/contract-v1/stream-open.workspace-follow.json', import.meta.url), 'utf8'))
const workspaceBaselineWait = nextRemoteFrame()
remoteSocket.send(JSON.stringify({ ...workspaceFollowOpen, streamId: 'm0-product-workspace-follow' }))
const workspaceBaselineFrame = await workspaceBaselineWait
assert.equal(workspaceBaselineFrame.type, 'item')
assert.equal(workspaceBaselineFrame.streamId, 'm0-product-workspace-follow')
assert.equal(workspaceBaselineFrame.value?.type, 'baseline')
assert.ok(workspaceBaselineFrame.value.value.items.some((item) => item.workspaceId === workspace.value.workspace.workspaceId))
assert.ok(workspaceBaselineFrame.value.value.items.find((item) => item.workspaceId === workspace.value.workspace.workspaceId).sessionIds.includes(session.value.sessionId))

const renamedWorkspaceWait = nextRemoteFrame()
await remoteRpc('workspace/rename', {
  request: { workspaceId: workspace.value.workspace.workspaceId, title: 'M0 renamed workspace' },
})
const renamedWorkspaceFrame = await renamedWorkspaceWait
assert.equal(renamedWorkspaceFrame.type, 'item')
assert.equal(renamedWorkspaceFrame.streamId, 'm0-product-workspace-follow')
assert.equal(renamedWorkspaceFrame.value?.type, 'upsert')
assert.equal(renamedWorkspaceFrame.value.workspace.title, 'M0 renamed workspace')
remoteSocket.send(JSON.stringify({ type: 'cancel', streamId: 'm0-product-workspace-follow' }))

const firstEventStreamId = 'm0-product-events-1'
const secondEventStreamId = 'm0-product-events-2'
const firstEventClientId = await openRemoteEvents(firstEventStreamId)
const secondEventClientId = await openRemoteEvents(secondEventStreamId)
const eventResult = await submitEventResult(
  firstEventClientId,
  'm0-no-pending-waterfall',
  { kind: 'next' },
)
assert.equal(eventResult.value, undefined, 'the official current-generation result RPC accepts the no-op for a non-pending event')
const malformedEventResult = await fetch(`${remoteBaseURL}/api/$events/result`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${paired.deviceToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    type: 'client-request',
    rpcId: 'm0-malformed-event-result',
    method: '$events/result',
    payload: { args: { clientId: firstEventClientId, eventId: 'm0-invalid', outcome: { kind: 'next', extra: true } } },
  }),
})
assert.equal(malformedEventResult.status, 403, 'the production carrier blocks malformed Gateway-internal event outcomes')
const staleEventResult = await fetch(`${remoteBaseURL}/api/$events/result`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${paired.deviceToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    type: 'client-request',
    rpcId: 'm0-stale-event-result',
    method: '$events/result',
    payload: { args: { clientId: 'stale-event-client', eventId: 'm0-invalid', outcome: { kind: 'next' } } },
  }),
})
assert.equal(staleEventResult.status, 200)
const staleEventEnvelope = await staleEventResult.json()
assert.equal(staleEventEnvelope.result.ok, false, 'the official Gateway rejects an event result from an expired stream generation')
assert.equal(staleEventEnvelope.result.error.code, 'gateway/internal')
const nextRun = await startHostQuestion('m0-question-next')
const nextDeliveries = [await nextRemoteEventFrameOfType('waterfall'), await nextRemoteEventFrameOfType('waterfall')]
for (const frame of nextDeliveries) {
  assert.equal(frame.type, 'item')
  assert.equal(frame.value?.type, 'waterfall')
  assert.equal(frame.value?.event, 'user-questions/request')
  assert.equal(frame.value?.agentId, nextRun.agentId)
  assert.equal(frame.value?.request?.questions?.[0]?.id, 'm0-question-next')
  assert.equal(Object.hasOwn(frame.value.request, 'agent'), false)
  assert.equal(Object.hasOwn(frame.value.request, 'signal'), false)
}
assert.equal(nextDeliveries[0].value.eventId, nextDeliveries[1].value.eventId, 'one pending Host question is fanned out with one eventId')
assert.deepEqual(new Set(nextDeliveries.map((frame) => frame.streamId)), new Set([firstEventStreamId, secondEventStreamId]))
await assertWaterfallFixture(nextDeliveries[0].value, 'waterfall-event.user-question.json')
await submitEventResult(firstEventClientId, nextDeliveries[0].value.eventId, { kind: 'next' })
assert.equal((await readHostQuestion(nextRun.runId)).status, 'pending', 'next withdraws only one Client delivery')
await submitEventResult(secondEventClientId, nextDeliveries[0].value.eventId, {
  kind: 'result',
  value: { answers: [{ id: 'm0-question-next', selected: ['Continue'] }] },
})
const nextOutcome = await waitForHostQuestion(nextRun.runId)
assert.equal(nextOutcome.ok, true)
assert.deepEqual(nextOutcome.value.answers, [{ id: 'm0-question-next', selected: ['Continue'] }])
await disposeHostQuestion(nextRun.runId)

const winnerRun = await startHostQuestion('m0-question-first-terminal')
const winnerDeliveries = [await nextRemoteEventFrameOfType('waterfall'), await nextRemoteEventFrameOfType('waterfall')]
for (const frame of winnerDeliveries) {
  assert.equal(frame.type, 'item')
  assert.equal(frame.value?.type, 'waterfall')
  assert.equal(frame.value?.event, 'user-questions/request')
  assert.equal(frame.value?.agentId, winnerRun.agentId)
}
assert.equal(winnerDeliveries[0].value.eventId, winnerDeliveries[1].value.eventId)
const winningDelivery = winnerDeliveries.find((frame) => frame.streamId === firstEventStreamId)
const losingDelivery = winnerDeliveries.find((frame) => frame.streamId === secondEventStreamId)
assert.ok(winningDelivery && losingDelivery)
await submitEventResult(firstEventClientId, winningDelivery.value.eventId, {
  kind: 'result',
  value: { answers: [{ id: 'm0-question-first-terminal', selected: ['Continue'] }] },
})
const losingDeliveryCancel = await nextRemoteEventFrameOfType('cancel')
assert.equal(losingDeliveryCancel.type, 'item')
assert.equal(losingDeliveryCancel.streamId, secondEventStreamId)
assert.deepEqual(losingDeliveryCancel.value, { type: 'cancel', eventId: winningDelivery.value.eventId })
assert.deepEqual((await waitForHostQuestion(winnerRun.runId)).value.answers, [
  { id: 'm0-question-first-terminal', selected: ['Continue'] },
])
await disposeHostQuestion(winnerRun.runId)

const approvalRun = await startHostApproval()
const approvalDeliveries = [await nextRemoteEventFrameOfType('waterfall'), await nextRemoteEventFrameOfType('waterfall')]
for (const frame of approvalDeliveries) {
  assert.equal(frame.value?.type, 'waterfall')
  assert.equal(frame.value?.event, 'approval/request')
  assert.equal(frame.value?.agentId, approvalRun.agentId)
  assert.equal(frame.value?.request?.toolName, 'm0-probe-tool')
  assert.equal(frame.value?.request?.callId, 'm0-probe-call')
  assert.equal(Object.hasOwn(frame.value.request, 'signal'), false)
}
assert.equal(approvalDeliveries[0].value.eventId, approvalDeliveries[1].value.eventId)
await assertWaterfallFixture(approvalDeliveries[0].value, 'waterfall-event.approval.json')
const approvalWinner = approvalDeliveries.find((frame) => frame.streamId === firstEventStreamId)
const approvalLoser = approvalDeliveries.find((frame) => frame.streamId === secondEventStreamId)
assert.ok(approvalWinner && approvalLoser)
await submitEventResult(firstEventClientId, approvalWinner.value.eventId, {
  kind: 'result',
  value: 'allowed-once',
})
const approvalLoserCancel = await nextRemoteEventFrameOfType('cancel')
assert.equal(approvalLoserCancel.streamId, secondEventStreamId)
assert.deepEqual(approvalLoserCancel.value, { type: 'cancel', eventId: approvalWinner.value.eventId })
const approvalOutcome = await waitForHostApproval(approvalRun.runId)
assert.equal(approvalOutcome.ok, true)
assert.equal(approvalOutcome.value, 'allowed-once')
assert.deepEqual(approvalOutcome.audit.map((event) => event.type), ['approval/asked', 'approval/decided'])
assert.equal(approvalOutcome.audit[1].data.outcome, 'allowed-once')
await disposeHostApproval(approvalRun.runId)

const cancelledRun = await startHostQuestion('m0-question-host-cancel')
const cancelledDeliveries = [await nextRemoteEventFrameOfType('waterfall'), await nextRemoteEventFrameOfType('waterfall')]
assert.equal(cancelledDeliveries[0].value?.eventId, cancelledDeliveries[1].value?.eventId)
const hostCancelResponse = await fetch(`${baseURL}/m0/events/question-runs/${cancelledRun.runId}/cancel`, { method: 'POST' })
assert.equal(hostCancelResponse.status, 200)
const cancellationFrames = [await nextRemoteEventFrameOfType('cancel'), await nextRemoteEventFrameOfType('cancel')]
assert.deepEqual(new Set(cancellationFrames.map((frame) => frame.streamId)), new Set([firstEventStreamId, secondEventStreamId]))
for (const frame of cancellationFrames) {
  assert.equal(frame.value?.type, 'cancel')
  assert.equal(frame.value?.eventId, cancelledDeliveries[0].value.eventId)
}
const cancelledOutcome = await waitForHostQuestion(cancelledRun.runId)
assert.equal(cancelledOutcome.ok, false)
assert.equal(cancelledOutcome.error.code, 'ASK_ABORTED')
await disposeHostQuestion(cancelledRun.runId)

remoteSocket.send(JSON.stringify({ type: 'cancel', streamId: firstEventStreamId }))
await new Promise((resolve) => setTimeout(resolve, 100))
assert.equal(remoteSocket.readyState, WebSocket.OPEN, 'cancelling one real event stream preserves its physical sibling stream')

const replayRun = await startHostQuestion('m0-question-replay')
const originalReplayDelivery = await nextRemoteEventFrameOfType('waterfall')
assert.equal(originalReplayDelivery.streamId, secondEventStreamId)
assert.equal(originalReplayDelivery.value?.event, 'user-questions/request')
assert.equal(originalReplayDelivery.value?.agentId, replayRun.agentId)
const oldReplayClientIds = new Set([firstEventClientId, secondEventClientId])
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Old Remote socket did not close before pending-event replay.')), 5_000)
  remoteSocket.once('close', () => {
    clearTimeout(timer)
    resolve()
  })
  remoteSocket.close(1000, 'M0 pending-event generation replacement')
})
assert.equal((await readHostQuestion(replayRun.runId)).status, 'pending', 'disconnect preserves the official still-pending Host question')

const replaySocket = new WebSocket(remoteMuxURL, {
  headers: { authorization: `Bearer ${paired.deviceToken}` },
})
const replayFrames = []
let replayFrameWaiter
replaySocket.on('message', (data) => {
  const encoded = data.toString()
  if (!replayFrameWaiter) {
    replayFrames.push(encoded)
    return
  }
  const waiter = replayFrameWaiter
  replayFrameWaiter = undefined
  clearTimeout(waiter.timer)
  waiter.resolve(parseRemoteStreamServerMessage(encoded))
})
replaySocket.on('close', (code) => {
  if (!replayFrameWaiter) return
  const waiter = replayFrameWaiter
  replayFrameWaiter = undefined
  clearTimeout(waiter.timer)
  waiter.reject(new Error(`Replacement event socket closed before expected frame (${code}).`))
})
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timed out opening the replacement event generation.')), 5_000)
  replaySocket.once('open', () => {
    clearTimeout(timer)
    resolve()
  })
  replaySocket.once('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
})
async function nextReplayFrame() {
  if (replayFrames.length) return Promise.resolve(parseRemoteStreamServerMessage(replayFrames.shift()))
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        if (replayFrameWaiter === waiter) replayFrameWaiter = undefined
        reject(new Error('Timed out waiting for the replacement-generation event frame.'))
      }, 5_000),
    }
    replayFrameWaiter = waiter
  })
}
const replayStreamId = 'm0-product-events-reconnected'
const replayReadyWait = nextReplayFrame()
replaySocket.send(JSON.stringify({ ...remoteEventsOpen, streamId: replayStreamId }))
const replayReadyFrame = await replayReadyWait
assert.equal(replayReadyFrame.type, 'item')
assert.equal(replayReadyFrame.streamId, replayStreamId)
assert.equal(replayReadyFrame.value?.type, 'ready')
const replacementClientId = replayReadyFrame.value.clientId
assert.equal(oldReplayClientIds.has(replacementClientId), false, 'a physical reconnect receives a new event client generation')
const replayEventWait = nextReplayFrame()
const replayedEventFrame = await replayEventWait
assert.equal(replayedEventFrame.type, 'item')
assert.equal(replayedEventFrame.streamId, replayStreamId)
assert.equal(replayedEventFrame.value?.type, 'waterfall')
assert.equal(replayedEventFrame.value?.event, 'user-questions/request')
assert.equal(replayedEventFrame.value?.eventId, originalReplayDelivery.value.eventId, 'the Host replays the same still-pending eventId')
assert.equal(replayedEventFrame.value?.agentId, replayRun.agentId)
await submitEventResult(replacementClientId, replayedEventFrame.value.eventId, {
  kind: 'result',
  value: { answers: [{ id: 'm0-question-replay', selected: ['Stop'] }] },
})
const replayOutcome = await waitForHostQuestion(replayRun.runId)
assert.deepEqual(replayOutcome.value.answers, [{ id: 'm0-question-replay', selected: ['Stop'] }])
await disposeHostQuestion(replayRun.runId)
replaySocket.send(JSON.stringify({ type: 'cancel', streamId: replayStreamId }))
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Replacement event socket did not close.')), 5_000)
  replaySocket.once('close', () => {
    clearTimeout(timer)
    resolve()
  })
  replaySocket.close(1000, 'M0 pending-event replay complete')
})

assert.equal(remoteSocket.readyState, WebSocket.CLOSED, 'the old physical event generation is closed')
assert.equal(replaySocket.readyState, WebSocket.CLOSED, 'the replacement event generation closed cleanly')
/* old logical event streams were disposed with the old physical connection */

const reconnectedSocket = new WebSocket(remoteMuxURL, {
  headers: { authorization: `Bearer ${paired.deviceToken}` },
})
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timed out reconnecting to the production Remote WebSocket carrier.')), 5_000)
  reconnectedSocket.once('open', () => {
    clearTimeout(timer)
    resolve()
  })
  reconnectedSocket.once('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
})
const reconnectedStreamId = 'm0-product-workspace-follow-reconnected'
const reconnectedBaselineWait = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timed out waiting for the reconnected workspace baseline.')), 5_000)
  reconnectedSocket.once('message', (data) => {
    clearTimeout(timer)
    resolve(parseRemoteStreamServerMessage(data.toString()))
  })
  reconnectedSocket.once('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
})
reconnectedSocket.send(JSON.stringify({ ...workspaceFollowOpen, streamId: reconnectedStreamId }))
const reconnectedBaselineFrame = await reconnectedBaselineWait
assert.equal(reconnectedBaselineFrame.type, 'item')
assert.equal(reconnectedBaselineFrame.streamId, reconnectedStreamId)
assert.equal(reconnectedBaselineFrame.value?.type, 'baseline')
const reconnectedWorkspace = reconnectedBaselineFrame.value.value.items.find((item) => item.workspaceId === workspace.value.workspace.workspaceId)
assert.equal(reconnectedWorkspace?.title, 'M0 renamed workspace', 'new physical connection receives the latest complete workspace state')
assert.ok(reconnectedWorkspace?.sessionIds.includes(session.value.sessionId))
assert.ok(Array.isArray(reconnectedBaselineFrame.value.value.archivedSessionIds))
assert.ok(Array.isArray(reconnectedBaselineFrame.value.value.pinnedSessionIds))
reconnectedSocket.send(JSON.stringify({ type: 'cancel', streamId: reconnectedStreamId }))
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Reconnected production Remote WebSocket did not close.')), 5_000)
  reconnectedSocket.once('close', () => {
    clearTimeout(timer)
    resolve()
  })
  reconnectedSocket.close(1000, 'M0 reconnect probe complete')
})

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
  productionEventResultRPC: eventResult.value === undefined,
  malformedEventResultRejected: malformedEventResult.status === 403,
  staleEventClientIdRejectedByGateway: staleEventEnvelope.result.ok === false,
  officialQuestionRequestResult: nextOutcome.ok && winnerRun.runId.length > 0,
  officialApprovalRequestResultAndAudit: approvalOutcome.value === 'allowed-once' && approvalOutcome.audit.length === 2,
  eventNextIsDeliveryScoped: nextOutcome.ok,
  firstTerminalResultCancelsSibling: losingDeliveryCancel.value.type === 'cancel',
  hostQuestionAbortPropagates: cancelledOutcome.error.code === 'ASK_ABORTED',
  pendingQuestionReplayedOnNewGeneration: replayOutcome.ok && !oldReplayClientIds.has(replacementClientId),
  ordinaryEventsObserved: ordinaryEventNames.length,
  productionPairingAndInfo: true,
  productionSettingsDescribeSchemaAndRedaction: true,
  officialSettingsRevisionConflictAndCAS: true,
  settingsRevisionConflictCode: staleSettingsMutation.error.code,
  settingsRevisionConflictDetails: staleSettingsMutation.error.details,
  settingsCurrentRevisionAccepted: idempotentSettingsMutation.value.revision,
  productionWorkspaceFollowBaselineAndUpsert: true,
  productionWorkspaceFollowReconnectBaseline: true,
  productionReadBytesHex: Buffer.from(remoteRead.byteParts.get('bytes-0')).toString('hex'),
  productionStreamingUploadSucceeded: true,
  productionWebSocketMuxReady: true,
  productionWebSocketStreamIsolation: true,
  websocketMuxReady: true,
  websocketLogicalStreamIsolation: true,
}))
