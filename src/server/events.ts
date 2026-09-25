import type { Context } from '@deepseek-ai/cordis'
import type { PhoneSocket } from './ws.ts'

interface EventBridgeOptions {
  /** Live authenticated phone sockets. */
  sockets: Set<PhoneSocket>
  log?: (message: string) => void
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return null
  }
}

/**
 * Forward coarse Host session events to every connected phone as
 * `{type:'notify', event, payload}` frames. These drive the phone's session
 * list; per-session content arrives through `session/follow` streams.
 */
export function startEventBridge(ctx: Context, options: EventBridgeOptions): () => void {
  const broadcast = (event: string, payload: unknown): void => {
    for (const socket of options.sockets) socket.notify(event, payload)
  }

  const off: Array<() => void> = []
  const listeners: Array<[string, (...args: unknown[]) => void]> = [
    [
      'api-session/added',
      (summary) => broadcast('api-session/added', jsonSafe(summary)),
    ],
    [
      'api-session/removed',
      (sessionId) => broadcast('api-session/removed', { sessionId }),
    ],
    [
      'api-session/status',
      (sessionId, running) => broadcast('api-session/status', { sessionId, running }),
    ],
    [
      'api-session/activity',
      (sessionId, updatedAt) => broadcast('api-session/activity', { sessionId, updatedAt }),
    ],
  ]
  for (const [event, listener] of listeners) {
    off.push((ctx.on as unknown as (name: string, cb: (...args: unknown[]) => void) => () => void)(event, listener))
  }
  return () => {
    for (const dispose of off) dispose()
  }
}
