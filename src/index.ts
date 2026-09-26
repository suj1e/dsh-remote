import type { Context } from '@deepseek-ai/cordis'
import { DeviceRegistry, type PairingWindow, type RegisteredDevice } from './access/device-registry.js'
import { loadOrCreateHostIdentity } from './access/host-identity.js'
import {
  Config,
  createRemoteCarrier,
  currentHostName,
  currentHostPlatform,
  loadHostVersion,
  type RemoteAccessMetadata,
  type RemoteCarrierConfig,
} from './server/remote-carrier.js'

export { Config }
export const inject = ['connection', 'typertGateway'] as const

export interface DshRemoteControl {
  readonly listenAddress: string
  openPairingWindow(durationMs?: number): PairingWindow
  closePairingWindow(): void
  listDevices(): Promise<RegisteredDevice[]>
  revokeDevice(deviceId: string): Promise<RegisteredDevice | undefined>
  accessMetadata(): RemoteAccessMetadata
}

interface ProfileContext {
  installAnchor?: string
}

export function apply(ctx: Context, rawConfig?: unknown): void {
  ctx.effect(async () => {
    const config = Config(rawConfig ?? {}) as RemoteCarrierConfig
    const profileContext = ctx.get('profileContext') as ProfileContext | undefined
    const [identity, dshVersion, registry] = await Promise.all([
      loadOrCreateHostIdentity(),
      loadHostVersion(profileContext?.installAnchor),
      DeviceRegistry.open(),
    ])
    const carrier = await createRemoteCarrier({
      config,
      registry,
      fetchHandler: ctx.connection.createSharedFetchHandler('/api'),
      gateway: ctx.typertGateway,
      host: {
        identity,
        dshVersion,
        name: currentHostName(),
        platform: currentHostPlatform(),
      },
    })
    const control: DshRemoteControl = {
      listenAddress: carrier.address,
      openPairingWindow: (durationMs) => registry.openPairingWindow(Date.now(), durationMs),
      closePairingWindow: () => registry.closePairingWindow(),
      listDevices: () => registry.listDevices(),
      revokeDevice: async (deviceId) => {
        const device = await registry.revoke(deviceId)
        if (device) carrier.closeDevice(device.id)
        return device
      },
      accessMetadata: () => carrier.metadata(),
    }
    const unprovideControl = ctx.provide('dshRemoteControl', control)
    ctx.logger('dsh-remote').info(`Remote carrier listening at ${carrier.address}.`)

    return async () => {
      unprovideControl()
      await carrier.close()
    }
  }, 'DSH Remote carrier and device registry')
}
