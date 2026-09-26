import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

interface AtomicWriteOptions {
  mode?: number
}

type AtomicWriteFile = (
  filePath: string,
  data: string,
  options?: AtomicWriteOptions,
) => Promise<void>

const require = createRequire(import.meta.url)
const writeFileAtomic = require('write-file-atomic') as AtomicWriteFile

export interface HostIdentity {
  schemaVersion: 1
  instanceId: string
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function decodeIdentity(json: string): HostIdentity {
  const value: unknown = JSON.parse(json)
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    !('schemaVersion' in value) || value.schemaVersion !== 1 ||
    !('instanceId' in value) || typeof value.instanceId !== 'string' ||
    !uuidPattern.test(value.instanceId)
  ) {
    throw new Error('The persisted DSH Remote host identity is invalid; refusing to rotate it.')
  }
  return { schemaVersion: 1, instanceId: value.instanceId }
}

/** Read or create the stable identity stored under the official DSH home. */
export async function loadOrCreateHostIdentity(
  filePath = dshHomePath('plugins', 'dsh-remote', 'host-identity.json'),
): Promise<HostIdentity> {
  try {
    return decodeIdentity(await readFile(filePath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const identity: HostIdentity = { schemaVersion: 1, instanceId: randomUUID() }
  await writeFileAtomic(filePath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  return identity
}
