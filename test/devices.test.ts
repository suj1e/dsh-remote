import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DeviceStore } from '../src/server/devices.ts'

function tempStore(): { store: DeviceStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-test-'))
  const store = new DeviceStore(join(dir, 'devices.json'))
  store.load()
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('store generates a 6-digit pairing code', () => {
  const { store, cleanup } = tempStore()
  try {
    assert.match(store.pairingCode, /^\d{6}$/)
    assert.equal(store.verifyPairingCode(store.pairingCode), true)
    assert.equal(store.verifyPairingCode('000000x'), false)
    assert.equal(store.verifyPairingCode(undefined), false)
  } finally {
    cleanup()
  }
})

test('rotate changes the code and persists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-test-'))
  const path = join(dir, 'devices.json')
  try {
    const store = new DeviceStore(path)
    store.load()
    const before = store.pairingCode
    const after = store.rotatePairingCode()
    assert.notEqual(before, after)
    const reopened = new DeviceStore(path)
    reopened.load()
    assert.equal(reopened.pairingCode, after)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pair mints a token that authenticates until revoked', () => {
  const { store, cleanup } = tempStore()
  try {
    const { id, token } = store.pair('iPhone 测试')
    assert.ok(id)
    assert.match(token, /^[0-9a-f]{64}$/)
    const device = store.authenticate(token)
    assert.equal(device?.name, 'iPhone 测试')
    assert.equal(store.authenticate('wrong-token'), undefined)
    assert.equal(store.authenticate(undefined), undefined)
    assert.equal(store.revoke(id), true)
    assert.equal(store.authenticate(token), undefined)
    assert.equal(store.revoke(id), false)
  } finally {
    cleanup()
  }
})

test('unnamed devices fall back to a placeholder name', () => {
  const { store, cleanup } = tempStore()
  try {
    const { token } = store.pair(42)
    assert.equal(store.authenticate(token)?.name, '未命名设备')
  } finally {
    cleanup()
  }
})
