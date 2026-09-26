import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DeviceRegistry, sanitizeDeviceName } from '../dist/access/device-registry.js'

async function temporaryRegistry(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-devices-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, path: join(directory, 'devices-v1.json') }
}

test('pairs multiple devices in one operator-opened window and persists only token digests', async (t) => {
  const { path } = await temporaryRegistry(t)
  const registry = await DeviceRegistry.open(path)
  const window = registry.openPairingWindow(1_800_000_000_000)
  assert.match(window.code, /^\d{10}$/)
  assert.equal(Date.parse(window.expiresAt), 1_800_000_300_000)

  const first = await registry.pair(window.code, '  iPhone  ', 1_800_000_001_000)
  const second = await registry.pair(window.code, 'iPad', 1_800_000_002_000)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (!first.ok || !second.ok) assert.fail('valid pairing code was rejected')
  assert.equal(first.device.name, 'iPhone')
  assert.match(first.deviceToken, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(first.deviceToken, second.deviceToken)

  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(stored.devices.length, 2)
  assert.ok(stored.devices.every(({ tokenHash }) => /^[0-9a-f]{64}$/.test(tokenHash)))
  assert.ok(stored.devices.every(({ tokenHash }) => ![first.deviceToken, second.deviceToken].includes(tokenHash)))

  const reopened = await DeviceRegistry.open(path)
  assert.equal((await reopened.authenticate(first.deviceToken))?.id, first.device.id)
  assert.equal((await reopened.authenticate(second.deviceToken))?.id, second.device.id)
})

test('expires and locks pairing windows, and never authenticates a revoked device', async (t) => {
  const { path } = await temporaryRegistry(t)
  const registry = await DeviceRegistry.open(path)
  const expired = registry.openPairingWindow(10_000, 30_000)
  assert.deepEqual(await registry.pair(expired.code, 'iPhone', 40_000), { ok: false, reason: 'expired' })
  assert.deepEqual(await registry.pair(expired.code, 'iPhone', 40_001), { ok: false, reason: 'closed' })

  const window = registry.openPairingWindow(50_000)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.deepEqual(await registry.pair('0000000000', 'iPhone', 51_000 + attempt), {
      ok: false,
      reason: 'invalid',
    })
  }
  assert.deepEqual(await registry.pair(window.code, 'iPhone', 52_000), { ok: false, reason: 'locked' })

  const nextWindow = registry.openPairingWindow(60_000)
  const paired = await registry.pair(nextWindow.code, 'iPhone', 61_000)
  if (!paired.ok) assert.fail('valid pairing code was rejected')
  assert.equal((await registry.revoke(paired.device.id, 62_000))?.revokedAt, new Date(62_000).toISOString())
  assert.equal(await registry.authenticate(paired.deviceToken), undefined)
  assert.equal((await registry.listDevices())[0]?.revokedAt, new Date(62_000).toISOString())
  assert.equal(await registry.revoke(paired.device.id), undefined)
})

test('rejects unsafe device names and fails closed on a corrupt persisted registry', async (t) => {
  assert.equal(sanitizeDeviceName('  iPhone\n Pro  '), undefined)
  assert.equal(sanitizeDeviceName('   '), undefined)
  assert.equal(sanitizeDeviceName('é'.repeat(65)), undefined)
  assert.equal(sanitizeDeviceName('  iPhone  '), 'iPhone')

  const { path } = await temporaryRegistry(t)
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    devices: [{
      id: '4c0e5556-144d-48af-9e75-942c94965b7a',
      name: 'bad\nname',
      createdAt: new Date().toISOString(),
      tokenHash: '0'.repeat(64),
    }],
  }))
  await assert.rejects(DeviceRegistry.open(path), /registry is invalid; refusing to reset it/)
})

test('serializes concurrent pairing writes without losing a device', async (t) => {
  const { path } = await temporaryRegistry(t)
  const registry = await DeviceRegistry.open(path)
  const window = registry.openPairingWindow()
  const paired = await Promise.all(Array.from({ length: 8 }, (_, index) => registry.pair(window.code, `iPhone ${index}`)))
  assert.ok(paired.every((result) => result.ok))
  assert.equal((await registry.listDevices()).length, 8)
})
