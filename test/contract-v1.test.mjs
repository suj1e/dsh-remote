import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'contract-v1')

async function fixture(name) {
  return JSON.parse(await readFile(join(fixtureDirectory, name), 'utf8'))
}

async function contract() {
  return JSON.parse(await readFile(new URL('../contract/contract-v1.json', import.meta.url), 'utf8'))
}

test('contract fixture pins the installed DSH source baseline and bounded real-Host evidence', async () => {
  const baseline = await contract()

  assert.equal(baseline.contractId, 'dshr-v1-dsh-0.1.7-rc.2-2026-09-26')
  assert.equal(baseline.dsh.appAsarSha256, 'afb3958a1a10e1abb2f48083ffec0d270eddec668a393c59e20db4f56ade6fde')
  assert.equal(baseline.sourceEvidence.hostRoundTrip, 'isolated-production-plugin-carrier-and-official-host-handler-on-macos')
  assert.deepEqual(baseline.hostRoundTripEvidence.testedEndpoints, [
    'settings/describe', 'settings/mutate', '$events/result', 'workspace/create', 'session/create', 'workspace/rename', 'workspace/follow', 'workspaceFiles/readBytes',
  ])
  assert.deepEqual(baseline.hostRoundTripEvidence.testedStreams, ['$events', 'workspace/follow'])
  assert.ok(baseline.hostRoundTripEvidence.additionalChecks.includes('settings-revision-conflict-and-current-revision-cas'))
  assert.ok(baseline.hostRoundTripEvidence.additionalChecks.includes('workspace-follow-baseline-after-new-connection'))
  assert.ok(baseline.hostRoundTripEvidence.limitations.includes('no Windows/Linux Host'))
  assert.ok(baseline.hostRoundTripEvidence.limitations.includes('no iOS network-reconnect generation test'))
  assert.ok(baseline.hostRoundTripEvidence.limitations.includes('no default-setting current-versus-next-session effect test'))
})

test('planned endpoint policy is exact, least-privilege, and guards generic mutation APIs', async () => {
  const policy = (await contract()).endpointPolicy

  assert.equal(policy.status, 'source-verified-planned-allowlist-host-roundtrip-pending')
  assert.equal(new Set(policy.unary).size, policy.unary.length)
  assert.equal(new Set(policy.streams).size, policy.streams.length)
  assert.deepEqual(policy.streams, [
    '$events',
    'session/control',
    'session/follow',
    'workspace/follow',
    'workspaceFiles/changes',
  ])
  assert.ok(policy.unary.includes('session/prompt'))
  assert.ok(policy.unary.includes('workspaceFiles/readBytes'))
  assert.ok(policy.unary.includes('commands/execute'))
  assert.ok(policy.conditionallyAllowed.includes('settings/mutate'))
  assert.equal(policy.argumentGuards['commands/execute'].startsWith('Only the /permission command'), true)
  assert.equal(policy.notExposed.includes('terminal/*'), true)
  assert.equal(policy.notExposed.includes('credentials/*'), true)
  assert.equal(policy.notExposed.includes('account/*'), true)
  assert.equal(policy.notExposed.includes('settings/update'), true)
  assert.deepEqual(policy.eventAllowlist, ['approval/request', 'user-questions/request'])
})

test('event results use the pinned Gateway unary endpoint and generation-scoped identifiers', async () => {
  const baseline = await contract()
  const request = await fixture('rpc-request.events-result.json')
  const args = request.payload.args

  assert.equal(baseline.eventDelivery.streamEndpoint, '$events')
  assert.equal(baseline.eventDelivery.resultEndpoint, '$events/result')
  assert.match(baseline.eventDelivery.resultTransport, /POST \/api\/\$events\/result unary RPC/)
  assert.match(baseline.eventDelivery.resultTransport, /downlink-only/)
  assert.ok(baseline.endpointPolicy.gatewayInternalUnary.includes('$events/result'))
  assert.equal(baseline.endpointPolicy.unary.includes('$events/result'), false)
  assert.equal(request.type, 'client-request')
  assert.equal(request.method, '$events/result')
  assert.deepEqual(Object.keys(args).sort(), ['clientId', 'eventId', 'outcome'])
  assert.deepEqual(args.outcome, { kind: 'result', value: 'allowed-once' })
})

test('official approval and user-question waterfall fixtures exclude Host-only Agent and signal fields', async () => {
  const approval = await fixture('waterfall-event.approval.json')
  const question = await fixture('waterfall-event.user-question.json')

  for (const frame of [approval, question]) {
    assert.deepEqual(Object.keys(frame).sort(), ['agentId', 'event', 'eventId', 'request', 'type'])
    assert.equal(frame.type, 'waterfall')
    assert.equal(frame.agentId, 'agent-fixture-1')
    assert.equal(frame.eventId, 'event-fixture-1')
    assert.equal('agent' in frame.request, false)
    assert.equal('signal' in frame.request, false)
  }
  assert.equal(approval.event, 'approval/request')
  assert.deepEqual(Object.keys(approval.request).sort(), ['callId', 'reason', 'toolName'])
  assert.equal(question.event, 'user-questions/request')
  assert.deepEqual(Object.keys(question.request), ['questions'])
  assert.equal(question.request.questions[0].multiSelect, false)
})

test('device pairing fixtures pin access metadata shape and keep the token pair-only', async () => {
  const baseline = await contract()
  const request = await fixture('pair-request.json')
  const paired = await fixture('pair-response.json')
  const info = await fixture('info-response.json')

  assert.equal(baseline.deviceAccess.accessVersion, 1)
  assert.equal(baseline.deviceAccess.pairing.path, '/v1/pair')
  assert.equal(baseline.deviceAccess.info.path, '/v1/info')
  assert.equal(request.code.length, 10)
  assert.deepEqual(Object.keys(paired).sort(), baseline.deviceAccess.pairing.successFields.slice().sort())
  assert.deepEqual(Object.keys(info).sort(), baseline.deviceAccess.info.successFields.slice().sort())
  assert.deepEqual(Object.keys(paired.endpoints).sort(), baseline.deviceAccess.metadata.endpoints.slice().sort())
  assert.deepEqual(paired.endpoints.gatewayInternalUnary, ['$events/result'])
  assert.match(paired.deviceToken, /^[A-Za-z0-9_-]{43}$/)
  assert.equal('deviceToken' in info, false)
  assert.equal(paired.host.instanceId, info.host.instanceId)
  assert.equal(paired.device.id, info.device.id)
  assert.equal(paired.contractId, baseline.contractId)
})

test('unary fixture preserves the official Connection request envelope and endpoint', async () => {
  const request = await fixture('rpc-request.session-list.json')

  assert.deepEqual(Object.keys(request).sort(), ['method', 'payload', 'rpcId', 'type'])
  assert.equal(request.type, 'client-request')
  assert.equal(request.method, 'session/list')
  assert.deepEqual(request.payload, { args: { _request: {} } })
})

test('session list fixture preserves the official cold-safe summary fields', async () => {
  const response = await fixture('rpc-response.session-list.json')

  assert.equal(response.type, 'server-response')
  assert.equal(response.result.ok, true)
  assert.equal(response.result.value.items.length, 1)
  assert.deepEqual(response.result.value.items[0], {
    agentAvailable: true,
    sessionId: 'session-fixture',
    updatedAt: 1790400000000,
    running: true,
    blank: false,
    cwd: '/work/example-project',
    projections: {
      kind: 'sequenced',
      asOfSeq: 8,
      values: { title: 'Fixture session' },
    },
  })
})

test('settings fixtures pin redacted default namespaces and revision-aware mutation', async () => {
  const described = await fixture('rpc-response.settings-describe.json')
  const mutation = await fixture('rpc-request.settings-mutate-cas.json')
  const staleMutation = await fixture('rpc-request.settings-mutate-stale.json')
  const conflict = await fixture('rpc-response.settings-mutate-conflict.json')
  const success = await fixture('rpc-response.settings-mutate-success.json')

  assert.equal(described.type, 'server-response')
  assert.equal(described.result.ok, true)
  assert.equal(described.result.value.writable, true)
  const namespaces = new Map(described.result.value.namespaces.map((namespace) => [namespace.ns, namespace]))
  const defaultModel = namespaces.get('agent-default-model')
  const permission = namespaces.get('permission')
  const modelFields = defaultModel.schema.refs[defaultModel.schema.uid].dict
  assert.deepEqual(Object.keys(modelFields).sort(), [
    'model', 'provider', 'reasoningEffort',
  ])
  for (const fieldName of ['provider', 'model']) {
    const field = defaultModel.schema.refs[modelFields[fieldName]]
    assert.equal(field.type, 'string')
    assert.equal(field.meta.required, true)
  }
  assert.equal(defaultModel.schema.refs[modelFields.reasoningEffort].type, 'string')
  assert.equal(defaultModel.schema.refs[modelFields.reasoningEffort].meta.required, undefined)
  assert.deepEqual(defaultModel.value, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(defaultModel.applies, 'live')
  assert.equal(defaultModel.revision, 0)
  const permissionFields = permission.schema.refs[permission.schema.uid].dict
  assert.deepEqual(Object.keys(permissionFields), ['defaultPreset'])
  assert.equal(permission.schema.refs[permissionFields.defaultPreset].type, 'string')
  assert.equal(permission.schema.refs[permissionFields.defaultPreset].meta.required, undefined)
  assert.equal(permission.applies, 'live')

  assert.equal(mutation.method, 'settings/mutate')
  assert.deepEqual(mutation.payload.args, {
    ns: 'agent-default-model',
    ops: [{ op: 'set', path: ['model'], value: 'deepseek-flash' }],
    expectedRevision: 0,
  })
  assert.equal(staleMutation.payload.args.expectedRevision, 1)
  assert.equal(conflict.result.ok, false)
  assert.equal(conflict.result.error.code, 'settings/conflict')
  assert.deepEqual(conflict.result.error.details, { ns: 'agent-default-model', expected: 1, actual: 0 })
  assert.equal(success.result.ok, true)
  assert.equal(success.result.value.ns, 'agent-default-model')
  assert.equal(success.result.value.revision, 0)
  assert.deepEqual(success.result.value.value, defaultModel.value)
})

test('workspace follow fixtures pin the official baseline and every ordered increment', async () => {
  const open = await fixture('stream-open.workspace-follow.json')
  const baseline = await fixture('workspace-follow.baseline.json')
  const upsert = await fixture('workspace-follow.upsert.json')
  const remove = await fixture('workspace-follow.remove.json')
  const order = await fixture('workspace-follow.order.json')
  const archived = await fixture('workspace-follow.archived.json')
  const pinned = await fixture('workspace-follow.pinned.json')

  assert.deepEqual(open, {
    type: 'open',
    streamId: 'fixture-workspace-follow-001',
    endpoint: 'workspace/follow',
    payload: { args: {} },
  })
  assert.equal(baseline.type, 'baseline')
  assert.deepEqual(Object.keys(baseline.value).sort(), ['archivedSessionIds', 'items', 'pinnedSessionIds'])
  assert.deepEqual(Object.keys(baseline.value.items[0]).sort(), [
    'createdAt', 'path', 'sessionIds', 'title', 'updatedAt', 'workspaceId',
  ])
  assert.equal(upsert.type, 'upsert')
  assert.equal(remove.type, 'remove')
  assert.equal(order.type, 'order')
  assert.equal(archived.type, 'archived')
  assert.equal(pinned.type, 'pinned')
})

test('business failures retain the official server-response result shape', async () => {
  const response = await fixture('rpc-response.error.json')

  assert.equal(response.type, 'server-response')
  assert.equal(response.result.ok, false)
  assert.deepEqual(Object.keys(response.result.error).sort(), ['code', 'details', 'message'])
  assert.equal(typeof response.result.error.details, 'object')
})

test('event stream opening uses the official mux path and empty event args', async () => {
  const baseline = await contract()
  const open = await fixture('stream-open.events.json')

  assert.equal(baseline.connection.stream.path, '/api/remote.mux')
  assert.equal(baseline.connection.stream.officialHostCarrier, 'ctx.typertGateway.wireStream.open')
  assert.equal(baseline.connection.stream.publicMuxServerExport, false)
  assert.equal(open.type, 'open')
  assert.equal(open.endpoint, '$events')
  assert.deepEqual(open.payload, { args: {} })
})

test('binary metadata points at a result-relative attachment and keeps high-bit bytes', async () => {
  const metadata = await fixture('binary-response.metadata.json')
  const part = await fixture('binary-response.part.json')
  const attachment = metadata.attachments[0]

  assert.equal(metadata.type, 'server-response')
  assert.equal(metadata.result.ok, true)
  assert.equal(metadata.result.value.data, null)
  assert.deepEqual(attachment, { path: ['data'], codec: 'bytes', part: 'bytes-0' })
  assert.deepEqual([...Buffer.from(part.bytesHex, 'hex')], [0, 127, 128, 255])
})

test('raw upload fixture matches the official streaming Fetch route', async () => {
  const baseline = await contract()
  const upload = await fixture('upload.raw-request.json')

  assert.equal(upload.method, baseline.connection.fileUpload.method)
  assert.equal(upload.path, baseline.connection.fileUpload.routePath)
  assert.equal(upload.contentType, baseline.connection.fileUpload.contentType)
  assert.equal(upload.bodyMode, 'streaming')
  assert.deepEqual([...Buffer.from(upload.bodyHex, 'hex')], [0, 127, 128, 255])
})
