import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadOrCreateHostIdentity } from '../dist/access/host-identity.js'

test('creates and then reuses one stable v4 Host instance identity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-identity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'identity.json')

  const first = await loadOrCreateHostIdentity(path)
  const second = await loadOrCreateHostIdentity(path)

  assert.equal(first.schemaVersion, 1)
  assert.match(first.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.deepEqual(second, first)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), first)
})

test('refuses a corrupt identity instead of silently changing the Host identity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-identity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'identity.json')
  await writeFile(path, '{"schemaVersion":1,"instanceId":"not-a-uuid"}')

  await assert.rejects(loadOrCreateHostIdentity(path), /refusing to rotate it/)
  assert.equal(await readFile(path, 'utf8'), '{"schemaVersion":1,"instanceId":"not-a-uuid"}')
})
