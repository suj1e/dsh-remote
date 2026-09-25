import type { WebSocket } from 'ws'
import { parseRemoteStreamClientMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { endpointAllowed, type GatewayLike } from './rpc.ts'

const HEARTBEAT_INTERVAL_MS = 30_000

/** Push-only async queue used as one logical stream's uplink. */
class UplinkQueue implements AsyncIterable<unknown> {
  private buffered: unknown[] = []
  private waiting: (() => void) | undefined
  private finished = false

  push(value: unknown): void {
    if (this.finished) return
    this.buffered.push(value)
    this.waiting?.()
  }

  end(): void {
    if (this.finished) return
    this.finished = true
    this.waiting?.()
  }

  abort(): void {
    this.buffered.length = 0
    this.finished = true
    this.waiting?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (;;) {
      while (this.buffered.length > 0) {
        yield this.buffered.shift()
      }
      if (this.finished) return
      await new Promise<void>((resolve) => {
        this.waiting = resolve
      })
      this.waiting = undefined
    }
  }
}

interface LiveStream {
  controller: AbortController
  uplink: UplinkQueue
  done: boolean
}

function wsSend(ws: WebSocket, value: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value))
}

export interface PhoneSocketOptions {
  gateway: GatewayLike
  allowedEndpoints: readonly string[]
  peer: unknown
  hello: Record<string, unknown>
  log?: (message: string) => void
}

/**
 * One authenticated phone WebSocket: logical Remote streams (same framing as
 * the browser's /api/remote.mux) plus `{type:'notify'}` host-event frames.
 */
export class PhoneSocket {
  private ws: WebSocket
  private options: PhoneSocketOptions
  private streams = new Map<string, LiveStream>()
  private heartbeat?: ReturnType<typeof setInterval>
  private closed = false

  private constructor(ws: WebSocket, options: PhoneSocketOptions) {
    this.ws = ws
    this.options = options
  }

  static attach(ws: WebSocket, options: PhoneSocketOptions): PhoneSocket {
    const socket = new PhoneSocket(ws, options)
    ws.on('message', (data) => void socket.onMessage(String(data)))
    ws.on('close', () => socket.dispose())
    ws.on('error', () => socket.dispose())
    socket.heartbeat = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping()
      }
    }, HEARTBEAT_INTERVAL_MS)
    wsSend(ws, { type: 'hello', ...options.hello })
    return socket
  }

  /** Push one host event notification frame. */
  notify(event: string, payload: unknown): void {
    wsSend(this.ws, { type: 'notify', event, payload })
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const stream of this.streams.values()) {
      stream.controller.abort()
      stream.uplink.abort()
    }
    this.streams.clear()
  }

  private async onMessage(text: string): Promise<void> {
    let message: ReturnType<typeof parseRemoteStreamClientMessage>
    try {
      message = parseRemoteStreamClientMessage(text)
    } catch (error) {
      this.options.log?.(`dropping malformed frame: ${(error as Error).message}`)
      this.ws.close(4003, 'invalid frame')
      return
    }
    if (message.type === 'open') {
      await this.openStream(message.streamId, message.endpoint, message.payload)
      return
    }
    const stream = this.streams.get(message.streamId)
    if (!stream) return
    if (message.type === 'item') {
      stream.uplink.push('value' in message ? message.value : undefined)
    } else if (message.type === 'end') {
      stream.uplink.end()
    } else if (message.type === 'cancel') {
      stream.controller.abort()
    }
  }

  private async openStream(streamId: string, endpoint: string, payload: unknown): Promise<void> {
    if (this.streams.has(streamId)) return
    const controller = new AbortController()
    const uplink = new UplinkQueue()
    const stream: LiveStream = { controller, uplink, done: false }
    this.streams.set(streamId, stream)
    if (!endpointAllowed(this.options.allowedEndpoints, endpoint)) {
      this.failStream(streamId, {
        code: 'remote/endpoint-forbidden',
        message: `endpoint ${JSON.stringify(endpoint)} is not allowed for this mobile server`,
        details: {},
      })
      return
    }
    let iterable: AsyncIterable<unknown>
    try {
      iterable = await this.options.gateway.wireStream.open(
        endpoint,
        payload as { args: Record<string, unknown> },
        uplink,
        this.options.peer,
        controller.signal,
      )
    } catch (error) {
      this.failStream(streamId, this.options.gateway.wireStream.failure(error))
      return
    }
    void this.pump(streamId, stream, iterable)
  }

  private async pump(streamId: string, stream: LiveStream, iterable: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const item of iterable) {
        if (stream.done) return
        // A top-level undefined downlink item is encoded as an item frame without `value`.
        wsSend(this.ws, item === undefined ? { type: 'item', streamId } : { type: 'item', streamId, value: item })
      }
      this.endStream(streamId)
    } catch (error) {
      this.failStream(streamId, this.options.gateway.wireStream.failure(error))
    }
  }

  private endStream(streamId: string): void {
    const stream = this.streams.get(streamId)
    if (stream) stream.done = true
    this.streams.delete(streamId)
    wsSend(this.ws, { type: 'end', streamId })
  }

  private failStream(streamId: string, error: { code: string; message: string; details: Record<string, unknown> }): void {
    const stream = this.streams.get(streamId)
    if (stream) stream.done = true
    this.streams.delete(streamId)
    wsSend(this.ws, { type: 'error', streamId, error })
  }
}
