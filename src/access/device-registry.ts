import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
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

export interface RegisteredDevice {
  id: string
  name: string
  createdAt: string
  revokedAt?: string
}

interface StoredDevice extends RegisteredDevice {
  tokenHash: string
}

interface DeviceRegistryFile {
  schemaVersion: 1
  devices: StoredDevice[]
}

export type PairingResult =
  | { ok: true; device: RegisteredDevice; deviceToken: string }
  | { ok: false; reason: 'closed' | 'expired' | 'invalid' | 'locked' }

export interface PairingWindow {
  code: string
  expiresAt: string
}

const DEFAULT_PAIRING_WINDOW_MS = 5 * 60_000
const MAX_PAIRING_FAILURES = 10
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const codePattern = /^\d{10}$/

const require = createRequire(import.meta.url)
const writeFileAtomic = require('write-file-atomic') as AtomicWriteFile

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function publicDevice(device: StoredDevice): RegisteredDevice {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
  }
}

function decodeRegistry(json: string): DeviceRegistryFile {
  const value: unknown = JSON.parse(json)
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.devices)) {
    throw new Error('The persisted DSH Remote device registry is invalid; refusing to reset it.')
  }

  const devices: StoredDevice[] = value.devices.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' || !uuidPattern.test(candidate.id) || candidate.id !== candidate.id.toLowerCase() ||
      typeof candidate.name !== 'string' || !isValidDeviceName(candidate.name) ||
      !validTimestamp(candidate.createdAt) ||
      typeof candidate.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.tokenHash) ||
      (candidate.revokedAt !== undefined && !validTimestamp(candidate.revokedAt))
    ) {
      throw new Error('The persisted DSH Remote device registry is invalid; refusing to reset it.')
    }

    return {
      id: candidate.id,
      name: candidate.name,
      createdAt: candidate.createdAt,
      tokenHash: candidate.tokenHash,
      ...(candidate.revokedAt ? { revokedAt: candidate.revokedAt } : {}),
    }
  })

  if (new Set(devices.map(({ id }) => id)).size !== devices.length) {
    throw new Error('The persisted DSH Remote device registry contains duplicate IDs; refusing to reset it.')
  }
  return { schemaVersion: 1, devices }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function normalizeDeviceName(value: string): string {
  const name = value.normalize('NFC').trim()
  if (!isValidDeviceName(name)) {
    throw new TypeError('Device name must contain 1–64 printable characters.')
  }
  return name
}

function isValidDeviceName(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Persistent per-Host device credentials and an ephemeral operator-owned pairing window. */
export class DeviceRegistry {
  private pairing: { codeHash: Buffer; expiresAt: number; failures: number } | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly filePath: string,
    private state: DeviceRegistryFile,
  ) {}

  static async open(
    filePath = dshHomePath('plugins', 'dsh-remote', 'devices-v1.json'),
  ): Promise<DeviceRegistry> {
    let state: DeviceRegistryFile
    try {
      state = decodeRegistry(await readFile(filePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = { schemaVersion: 1, devices: [] }
      await DeviceRegistry.persist(filePath, state)
    }
    return new DeviceRegistry(filePath, state)
  }

  openPairingWindow(now = Date.now(), durationMs = DEFAULT_PAIRING_WINDOW_MS): PairingWindow {
    if (!Number.isFinite(durationMs) || durationMs < 30_000 || durationMs > 10 * 60_000) {
      throw new RangeError('Pairing window duration must be between 30 seconds and 10 minutes.')
    }
    const code = String(randomInt(0, 10_000_000_000)).padStart(10, '0')
    const expiresAt = now + durationMs
    this.pairing = { codeHash: digest(code), expiresAt, failures: 0 }
    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  closePairingWindow(): void {
    this.pairing = undefined
  }

  async pair(code: string, rawDeviceName: string, now = Date.now()): Promise<PairingResult> {
    const window = this.pairing
    if (!window) return { ok: false, reason: 'closed' }
    if (now >= window.expiresAt) {
      this.pairing = undefined
      return { ok: false, reason: 'expired' }
    }
    if (window.failures >= MAX_PAIRING_FAILURES) {
      this.pairing = undefined
      return { ok: false, reason: 'locked' }
    }

    let candidate: Buffer
    try {
      if (!codePattern.test(code)) throw new Error('invalid pairing code')
      candidate = digest(code)
    } catch {
      window.failures += 1
      return { ok: false, reason: 'invalid' }
    }
    if (!timingSafeEqual(window.codeHash, candidate)) {
      window.failures += 1
      return { ok: false, reason: 'invalid' }
    }

    const name = normalizeDeviceName(rawDeviceName)
    const deviceToken = randomBytes(32).toString('base64url')
    const device: StoredDevice = {
      id: randomUUID(),
      name,
      createdAt: new Date(now).toISOString(),
      tokenHash: digest(deviceToken).toString('hex'),
    }
    await this.update((current) => ({ ...current, devices: [...current.devices, device] }))
    return { ok: true, device: publicDevice(device), deviceToken }
  }

  async authenticate(deviceToken: string): Promise<RegisteredDevice | undefined> {
    if (!tokenPattern.test(deviceToken)) return undefined
    const candidate = digest(deviceToken)
    await this.writeQueue
    for (const device of this.state.devices) {
      if (device.revokedAt) continue
      const stored = Buffer.from(device.tokenHash, 'hex')
      if (timingSafeEqual(candidate, stored)) return publicDevice(device)
    }
    return undefined
  }

  async listDevices(): Promise<RegisteredDevice[]> {
    await this.writeQueue
    return this.state.devices.map(publicDevice)
  }

  async revoke(deviceId: string, now = Date.now()): Promise<RegisteredDevice | undefined> {
    let revoked: RegisteredDevice | undefined
    await this.update((current) => {
      const device = current.devices.find((candidate) => candidate.id === deviceId && !candidate.revokedAt)
      if (!device) return current
      const nextDevice = { ...device, revokedAt: new Date(now).toISOString() }
      revoked = publicDevice(nextDevice)
      return {
        ...current,
        devices: current.devices.map((candidate) => candidate.id === deviceId ? nextDevice : candidate),
      }
    })
    return revoked
  }

  private update(transform: (current: DeviceRegistryFile) => DeviceRegistryFile): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const next = transform(this.state)
      await DeviceRegistry.persist(this.filePath, next)
      this.state = next
    })
    this.writeQueue = operation.catch(() => undefined)
    return operation
  }

  private static async persist(filePath: string, state: DeviceRegistryFile): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    await writeFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  }
}

export function sanitizeDeviceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return normalizeDeviceName(value)
  } catch {
    return undefined
  }
}
