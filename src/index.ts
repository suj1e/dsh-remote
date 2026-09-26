import type { Context } from '@deepseek-ai/cordis'
import { loadOrCreateHostIdentity } from './access/host-identity.js'

export const inject = [] as const

export function apply(ctx: Context): void {
  ctx.effect(async () => {
    const identity = await loadOrCreateHostIdentity()
    ctx.logger('dsh-remote').info('Persistent Host instance identity loaded.')
    return ctx.provide('dshRemoteHostIdentity', identity)
  }, 'load persistent Host identity')
}
