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
  assert.equal(baseline.sourceEvidence.hostRoundTrip, 'isolated-production-plugin-carrier-on-macos')
  assert.deepEqual(baseline.hostRoundTripEvidence.testedEndpoints, [
    'workspace/create', 'session/create', 'workspaceFiles/readBytes',
  ])
  assert.ok(baseline.hostRoundTripEvidence.limitations.includes('no Windows/Linux Host'))
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
