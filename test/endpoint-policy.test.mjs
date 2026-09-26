import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizeFetchRoute,
  authorizeStreamEndpoint,
  authorizeUnaryRequest,
} from '../dist/access/endpoint-policy.js'

const permissionContext = { presetValues: new Set(['workspace-write', 'danger-full-access']) }

function authorize(path, payload = { args: { _request: {} } }, method = 'POST') {
  return authorizeUnaryRequest({ method, path, payload, permissionContext })
}

test('allows exact official unary endpoint paths only', () => {
  assert.deepEqual(authorize('/api/session/list'), { allowed: true, endpoint: 'session/list' })
  assert.deepEqual(authorize('/api/workspaceFiles/readBytes'), {
    allowed: true,
    endpoint: 'workspaceFiles/readBytes',
  })
  assert.equal(authorize('/api/session/list/extra').allowed, false)
  assert.equal(authorize('/api/session%2Fcreate/x').allowed, false)
  assert.equal(authorize('/api/session/create?debug=1').allowed, false)
  assert.deepEqual(authorize('/api/session/list', undefined, 'GET'), {
    allowed: false,
    denial: 'method-not-allowed',
  })
})

test('allows only the exact official Gateway event-result RPC shape', () => {
  assert.deepEqual(authorize('/api/$events/result'), {
    allowed: false,
    denial: 'gateway-internal-only',
  })
  assert.deepEqual(authorize('/api/$events/result', {
    args: {
      clientId: 'event-client-1',
      eventId: 'event-request-1',
      outcome: { kind: 'result', value: 'allowed-once' },
    },
  }), { allowed: true, endpoint: '$events/result' })
  assert.deepEqual(authorize('/api/$events/result', {
    args: { clientId: 'event-client-1', eventId: 'event-request-1', outcome: { kind: 'next' } },
  }), { allowed: true, endpoint: '$events/result' })
  assert.deepEqual(authorize('/api/$events/result', {
    args: {
      clientId: 'event-client-1',
      eventId: 'event-request-1',
      outcome: { kind: 'result', value: 'allowed-once', extra: true },
    },
  }), { allowed: false, denial: 'gateway-internal-only' })
  assert.deepEqual(authorize('/api/$events/result', {
    args: {
      clientId: 'event-client-1',
      eventId: 'event-request-1',
      outcome: { kind: 'result', value: 'allowed-once' },
    },
    extra: true,
  }), { allowed: false, denial: 'gateway-internal-only' })
  assert.equal(authorize('/api/$events').allowed, false)
})

test('restricts commands/execute to a catalogued /permission command without attachments', () => {
  const base = { agentId: 'agent-1', submittedAttachments: [] }
  assert.equal(authorize('/api/commands/execute', {
    args: { ...base, line: '/permission workspace-write' },
  }).allowed, true)
  assert.equal(authorize('/api/commands/execute', {
    args: { ...base, line: '/permission' },
  }).allowed, true)
  assert.deepEqual(authorize('/api/commands/execute', {
    args: { ...base, line: '/bash whoami' },
  }), { allowed: false, denial: 'command-not-allowed' })
  assert.deepEqual(authorize('/api/commands/execute', {
    args: { ...base, line: '/permission unlisted' },
  }), { allowed: false, denial: 'command-not-allowed' })
  assert.deepEqual(authorize('/api/commands/execute', {
    args: { ...base, line: '/permission workspace-write && /bash whoami' },
  }), { allowed: false, denial: 'command-not-allowed' })
  assert.deepEqual(authorize('/api/commands/execute', {
    args: { ...base, line: '/permission workspace-write', submittedAttachments: [{ type: 'file' }] },
  }), { allowed: false, denial: 'command-not-allowed' })
})

test('settings mutation stays closed until exact paths and catalog guards are implemented', () => {
  assert.equal(authorize('/api/settings/describe').allowed, true)
  assert.deepEqual(authorize('/api/settings/mutate'), {
    allowed: false,
    denial: 'settings-mutation-not-enabled',
  })
})

test('allows only exact official multiplexed stream endpoints', () => {
  assert.deepEqual(authorizeStreamEndpoint('$events'), { allowed: true, endpoint: '$events' })
  assert.equal(authorizeStreamEndpoint('session/follow').allowed, true)
  assert.equal(authorizeStreamEndpoint('session/follow/extra').allowed, false)
  assert.equal(authorizeStreamEndpoint('session/prompt').allowed, false)
})

test('allows only the exact raw upload route, octet-stream, and documented query fields', () => {
  assert.deepEqual(authorizeFetchRoute({
    method: 'POST',
    pathAndQuery: '/api/session/uploadFileBinary?sessionId=s-1&name=report.txt',
    contentType: 'application/octet-stream',
  }), { allowed: true, endpoint: '/api/session/uploadFileBinary' })
  assert.equal(authorizeFetchRoute({
    method: 'POST',
    pathAndQuery: '/api/session/uploadFileBinary?sessionId=s-1&admin=true',
    contentType: 'application/octet-stream',
  }).allowed, false)
  assert.equal(authorizeFetchRoute({
    method: 'POST',
    pathAndQuery: '/api/session/uploadFileBinary?sessionId=s-1&sessionId=s-2',
    contentType: 'application/octet-stream',
  }).allowed, false)
  assert.equal(authorizeFetchRoute({
    method: 'POST',
    pathAndQuery: '/api/session/uploadFileBinary?sessionId=s-1',
    contentType: 'application/json',
  }).allowed, false)
  assert.equal(authorizeFetchRoute({
    method: 'GET',
    pathAndQuery: '/api/session/uploadFileBinary?sessionId=s-1',
    contentType: 'application/octet-stream',
  }).allowed, false)
})
