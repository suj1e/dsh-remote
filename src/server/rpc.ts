import type { Context } from '@deepseek-ai/cordis'
import type { DeviceRecord } from './devices.ts'

/** Wire failure shape, matching the Gateway's own Remote failure projection. */
export interface RemoteWireFailure {
  code: string
  message: string
  details: Record<string, unknown>
}

export type RemoteWireResult<T = unknown> = { ok: true; value: T } | { ok: false; error: RemoteWireFailure }

/** Minimal structural view of the Host API Gateway our proxy needs. */
export interface GatewayLike {
  /**
   * Dispatch one unary Remote call: strict validation, lookups, result codecs,
   * and the internal `$events/result` waterfall-answer endpoint.
   */
  dispatchRpc(
    endpoint: string,
    payload: { args: Record<string, unknown> },
    signal: AbortSignal | undefined,
    peer: unknown,
  ): Promise<RemoteWireResult>
  wireStream: {
    open(
      endpoint: string,
      payload: { args: Record<string, unknown> },
      uplink: AsyncIterable<unknown>,
      peer: unknown,
      signal: AbortSignal,
    ): Promise<AsyncIterable<unknown>>
    failure(error: unknown): RemoteWireFailure
  }
  operatorPeer(): unknown
}

/** Resolve ctx.typertGateway with its public surface. */
export function gatewayOf(ctx: Context): GatewayLike {
  const gateway = (ctx as { typertGateway?: unknown }).typertGateway as GatewayLike | undefined
  if (!gateway) throw new Error('dsh-remote: typertGateway service is unavailable')
  return gateway
}

/** Match an endpoint like "session/prompt" against patterns like "session/*" or "session/prompt". */
export function endpointAllowed(patterns: readonly string[], endpoint: string): boolean {
  const [namespace, method] = endpoint.split('/')
  if (!namespace || !method) return false
  return patterns.some((pattern) => {
    const [ns, methodPattern] = pattern.split('/')
    if (ns !== namespace) return false
    return methodPattern === '*' || methodPattern === method
  })
}

/**
 * Invoke one unary Remote endpoint in-process, through the same Gateway the
 * browser client uses. Returns the wire RemoteResult envelope.
 */
export async function invokeRemote(
  gateway: GatewayLike,
  endpoint: string,
  args: Record<string, unknown>,
  peer: unknown,
): Promise<RemoteWireResult> {
  try {
    return await gateway.dispatchRpc(endpoint, { args }, undefined, peer)
  } catch (error) {
    return { ok: false, error: gateway.wireStream.failure(error) }
  }
}

/** Device-facing admission record attached to each request/connection. */
export interface PhonePeer {
  device: DeviceRecord
}
