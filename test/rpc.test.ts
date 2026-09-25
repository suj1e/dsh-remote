import assert from 'node:assert/strict'
import { test } from 'node:test'
import { endpointAllowed } from '../src/server/rpc.ts'

test('namespace wildcard allows every method in the namespace', () => {
  assert.equal(endpointAllowed(['session/*'], 'session/prompt'), true)
  assert.equal(endpointAllowed(['session/*'], 'session/list'), true)
  assert.equal(endpointAllowed(['session/*'], 'workspace/list'), false)
})

test('exact method patterns match only that method', () => {
  assert.equal(endpointAllowed(['session/prompt'], 'session/prompt'), true)
  assert.equal(endpointAllowed(['session/prompt'], 'session/cancel'), false)
})

test('malformed endpoints are rejected', () => {
  assert.equal(endpointAllowed(['session/*'], 'session'), false)
  assert.equal(endpointAllowed(['*'], 'session/list'), false)
  assert.equal(endpointAllowed(['session/*'], 'session/'), false)
})
