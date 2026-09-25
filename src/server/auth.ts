import type { IncomingMessage } from 'node:http'
import net from 'node:net'

/** Extract a bearer token from an Authorization header. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1]
}

/** True when the socket peer addresses the loopback interface. */
export function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return net.isIPv4(address)
    ? address.startsWith('127.')
    : address === '::1' || address === '::ffff:127.0.0.1'
}

const WINDOW_MS = 5 * 60 * 1000
const MAX_FAILURES = 5

/** Per-IP pairing attempt limiter: MAX_FAILURES per window, then lock for the window. */
export class PairingRateLimiter {
  private failures = new Map<string, { count: number; windowStart: number; lockedUntil: number }>()

  /** Returns remaining lock time in ms, or 0 when the ip may attempt pairing. */
  lockedFor(ip: string, now = Date.now()): number {
    const entry = this.failures.get(ip)
    if (!entry) return 0
    if (entry.lockedUntil > now) return entry.lockedUntil - now
    if (now - entry.windowStart > WINDOW_MS) {
      this.failures.delete(ip)
      return 0
    }
    return 0
  }

  recordFailure(ip: string, now = Date.now()): void {
    const entry = this.failures.get(ip)
    if (!entry || now - entry.windowStart > WINDOW_MS) {
      this.failures.set(ip, { count: 1, windowStart: now, lockedUntil: 0 })
      return
    }
    entry.count += 1
    if (entry.count >= MAX_FAILURES) entry.lockedUntil = now + WINDOW_MS
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip)
  }
}
