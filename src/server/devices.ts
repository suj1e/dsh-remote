import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** One paired mobile device. */
export interface DeviceRecord {
  id: string
  /** User-visible device name supplied at pairing. */
  name: string
  /** SHA-256 hex digest of the bearer token (the token itself is never stored). */
  tokenHash: string
  createdAt: number
  lastSeenAt: number
}

/** Durable state for the mobile remote plugin. */
export interface RemoteStoreData {
  version: 1
  pairingCode: string
  pairingCodeUpdatedAt: number
  devices: DeviceRecord[]
}

function pairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function freshData(): RemoteStoreData {
  const now = Date.now()
  return { version: 1, pairingCode: pairingCode(), pairingCodeUpdatedAt: now, devices: [] }
}

/**
 * JSON-file-backed registry of paired devices and the active pairing code.
 * Writes are atomic (tmp file + rename); reads happen once at load.
 */
export class DeviceStore {
  private data: RemoteStoreData = freshData()
  private path: string
  private loaded = false
  /** In-memory token index for constant-time admission checks. */
  private byToken = new Map<string, DeviceRecord>()

  constructor(path = dshHomePath('mobile-remote', 'devices.json')) {
    this.path = path
  }

  load(): void {
    if (this.loaded) return
    this.loaded = true
    let existed = false
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as RemoteStoreData
      if (raw?.version === 1 && typeof raw.pairingCode === 'string' && Array.isArray(raw.devices)) {
        this.data = raw
        existed = true
      }
    } catch {
      // Missing or unreadable file starts fresh; persisted right below.
    }
    for (const device of this.data.devices) {
      this.byToken.set(device.tokenHash, device)
    }
    if (!existed) this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.path)
  }

  get pairingCode(): string {
    return this.data.pairingCode
  }

  get pairingCodeUpdatedAt(): number {
    return this.data.pairingCodeUpdatedAt
  }

  rotatePairingCode(): string {
    this.data.pairingCode = pairingCode()
    this.data.pairingCodeUpdatedAt = Date.now()
    this.save()
    return this.data.pairingCode
  }

  verifyPairingCode(code: unknown): boolean {
    return typeof code === 'string' && code === this.data.pairingCode && this.data.pairingCode.length === 6
  }

  /** Consume the pairing code and mint a device token. */
  pair(name: unknown): { id: string; token: string } {
    const token = randomBytes(32).toString('hex')
    const now = Date.now()
    const record: DeviceRecord = {
      id: randomUUID(),
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim().slice(0, 64) : '未命名设备',
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
    }
    this.data.devices.push(record)
    this.byToken.set(record.tokenHash, record)
    this.save()
    return { id: record.id, token }
  }

  /** Resolve a bearer token to its device, or undefined when unknown/revoked. */
  authenticate(token: string | undefined): DeviceRecord | undefined {
    if (!token) return undefined
    const record = this.byToken.get(hashToken(token))
    if (record) record.lastSeenAt = Date.now()
    return record
  }

  revoke(id: string): boolean {
    const index = this.data.devices.findIndex((device) => device.id === id)
    if (index === -1) return false
    const [removed] = this.data.devices.splice(index, 1)
    if (removed) this.byToken.delete(removed.tokenHash)
    this.save()
    return true
  }

  listDevices(): ReadonlyArray<Readonly<DeviceRecord>> {
    return this.data.devices.map((device) => ({ ...device }))
  }
}
