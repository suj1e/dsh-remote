import type { Context, Plugin } from '@deepseek-ai/cordis'
import { OperatorPeer } from '@deepseek-ai/dsh-client-connection'
import { Config, readVolatile, type Config as ConfigType } from './config.ts'
import { DeviceStore } from './server/devices.ts'
import { RemoteServer } from './server/http.ts'
import { gatewayOf } from './server/rpc.ts'
import { startEventBridge } from './server/events.ts'

/**
 * dsh-remote: let a paired mobile app use this DSH Host over the LAN.
 *
 * Owns one HTTP+WebSocket listener (independent of the loopback-only web GUI
 * webserver) that proxies the Host's Remote API — the same `typertGateway`
 * surface the browser client speaks — behind per-device bearer tokens.
 *
 * `enabled` is a volatile config field: the Settings page edits it through
 * the native config form, the Loader commits the new value into the running
 * reference without remounting, and this fiber reacts to
 * `loader/volatile-update` by starting/stopping the listener live.
 */
function dshRemote(ctx: Context, config: ConfigType): void {
  const log = (message: string): void => {
    ctx.logger.info(`[dsh-remote] ${message}`)
  }

  const store = new DeviceStore()
  store.load()
  const gateway = gatewayOf(ctx)

  // A peer scope owned by THIS fiber: the Connection's operator scope goes
  // inactive across client generations (page reloads), which made every
  // gateway dispatch fail with "typert in inactive context". The gateway's
  // own in-process carrier uses exactly this pattern.
  const peer = new OperatorPeer(ctx)

  let server: RemoteServer | undefined
  let stopBridge: (() => void) | undefined
  let closing = false

  const start = (): void => {
    if (server || closing) return
    const instance = new RemoteServer({ config, gateway, store, log, peer })
    server = instance
    stopBridge = startEventBridge(ctx, { sockets: instance.sockets, log })
    instance
      .listen()
      .then(({ port, addresses }) => {
        if (server !== instance) {
          void instance.close()
          return
        }
        const display = addresses.length > 0 ? addresses.map((a) => `${a}:${port}`).join(', ') : String(port)
        log(`listening on ${display}`)
      })
      .catch((error: NodeJS.ErrnoException) => {
        ctx.logger.error(`[dsh-remote] failed to listen on ${config.bind}:${config.port}: ${error.code ?? ''} ${error.message}`)
        if (server === instance) {
          server = undefined
          stopBridge?.()
          stopBridge = undefined
          void instance.close()
        }
      })
  }

  const stop = (): void => {
    const instance = server
    server = undefined
    stopBridge?.()
    stopBridge = undefined
    if (!instance) return
    closing = true
    void instance.close().then(() => {
      closing = false
      log('server closed (remote connections off)')
      // A toggle back on during the close window dropped its start event;
      // re-check once the listener is actually free.
      if (enabledNow() && !server) start()
    })
  }

  const enabledNow = (): boolean => readVolatile(config.enabled) !== false

  if (enabledNow()) {
    start()
  } else {
    log('remote connections are off; enable them in Settings')
  }

  ctx.on('loader/volatile-update', (paths) => {
    if (!paths.some((path) => path[0] === 'enabled')) return
    if (enabledNow()) {
      log('remote connections enabled')
      start()
    } else {
      stop()
    }
  })
}

const plugin: Plugin.Function<ConfigType> = Object.assign(dshRemote, {
  Config,
  inject: ['typertGateway'],
})

export default plugin
