import type { Context, Plugin } from '@deepseek-ai/cordis'
import { Config, type Config as ConfigType } from './config.ts'
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
 */
function dshRemote(ctx: Context, config: ConfigType): void {
  const log = (message: string): void => {
    ctx.logger.info(`[dsh-remote] ${message}`)
  }

  if (!config.enabled) {
    log('disabled by config; not listening')
    return
  }

  const store = new DeviceStore()
  store.load()
  const gateway = gatewayOf(ctx)

  ctx.effect(() => {
    const server = new RemoteServer({ config, gateway, store, log })
    const stopBridge = startEventBridge(ctx, {
      sockets: server.sockets,
      log,
    })
    let stopped = false

    server
      .listen()
      .then(({ port, addresses }) => {
        if (stopped) {
          void server.close()
          return
        }
        const display = addresses.length > 0 ? addresses.map((a) => `${a}:${port}`).join(', ') : `${port}`
        log(`listening on ${display} (management page: http://127.0.0.1:${port}/)`)
      })
      .catch((error: NodeJS.ErrnoException) => {
        ctx.logger.error(
          `[dsh-remote] failed to listen on ${config.bind}:${config.port}: ${error.code ?? ''} ${error.message}`,
        )
      })

    return () => {
      stopped = true
      stopBridge()
      void server.close().then(() => log('server closed'))
    }
  }, 'dsh-remote: mobile server')
}

const plugin: Plugin.Function<ConfigType> = Object.assign(dshRemote, {
  Config,
  inject: ['typertGateway'],
})

export default plugin
