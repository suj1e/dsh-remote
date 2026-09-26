import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { parseRemoteStreamClientMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import Fastify from 'fastify'

export const inject = ['connection', 'typertGateway']

export function apply(ctx) {
  ctx.effect(async () => {
    const home = process.env.DSH_HOME
    if (!home || !basename(home).startsWith('dsh-mobile-m0-host.')) {
      throw new Error('M0 Host probe requires its isolated dsh-mobile-m0-host.* home.')
    }

    const workspacePath = join(home, 'm0-workspace')
    await mkdir(workspacePath, { recursive: true })
    await writeFile(join(workspacePath, 'fixture.bin'), Buffer.from([0x00, 0x7f, 0x80, 0xff]))

    const fetchHandler = ctx.connection.createSharedFetchHandler('/api')
    const app = Fastify({ logger: false })

    const forwardJSON = async (request, reply) => {
      const url = new URL(request.url, 'http://dsh-m0.invalid')
      const fetchRequest = new Request(url, {
        method: request.method,
        headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
        body: JSON.stringify(request.body),
      })
      const response = await fetchHandler.fetch(fetchRequest)
      reply.status(response.status)
      for (const [name, value] of response.headers) reply.header(name, value)
      return reply.send(Buffer.from(await response.arrayBuffer()))
    }

    for (const path of [
      '/api/session/list',
      '/api/workspace/create',
      '/api/session/create',
      '/api/workspaceFiles/readBytes',
    ]) app.post(path, forwardJSON)

    app.addContentTypeParser('application/octet-stream', (request, payload, done) => {
      done(null, payload)
    })
    app.post('/api/session/uploadFileBinary', async (request, reply) => {
      const url = new URL(request.url, 'http://dsh-m0.invalid')
      const bodyMode = fetchHandler.requestBodyMode({ method: request.method, url })
      if (bodyMode !== 'streaming') return reply.code(500).send('official Fetch route is not streaming')

      const abort = new AbortController()
      request.raw.once('aborted', () => abort.abort())
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) abort.abort()
      })
      const fetchRequest = new Request(url, {
        method: request.method,
        headers: { 'content-type': request.headers['content-type'] ?? 'application/octet-stream' },
        body: Readable.toWeb(request.body),
        signal: abort.signal,
        duplex: 'half',
      })
      const response = await fetchHandler.fetch(fetchRequest)
      reply.status(response.status)
      for (const [name, value] of response.headers) reply.header(name, value)
      return reply.send(Buffer.from(await response.arrayBuffer()))
    })

    app.post('/m0/stream/probe', async (request, reply) => {
      const message = parseRemoteStreamClientMessage(JSON.stringify(request.body))
      if (message.endpoint !== '$events') {
        return reply.code(400).send({ error: 'M0 probe only opens the official $events stream.' })
      }

      const abort = new AbortController()
      const stream = await ctx.typertGateway.wireStream.open(
        message.endpoint,
        message.payload,
        { async *[Symbol.asyncIterator]() {} },
        undefined,
        abort.signal,
      )
      const iterator = stream[Symbol.asyncIterator]()
      let timer
      try {
        const first = await Promise.race([
          iterator.next(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out waiting for $events ready.')), 8_000)
          }),
        ])
        clearTimeout(timer)
        if (first.done || first.value?.type !== 'ready') {
          abort.abort(new Error('M0 probe received an unexpected $events opening item.'))
          return reply.code(502).send({ firstItemDone: first.done, firstItemType: first.value?.type })
        }

        const pendingNext = iterator.next()
        abort.abort(new Error('M0 probe cancellation.'))
        const cancellationSettled = await Promise.race([
          pendingNext.then(() => true, () => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 3_000)
          }),
        ])
        clearTimeout(timer)
        if (cancellationSettled) await iterator.return?.()
        return reply.send({ firstItemType: first.value.type, cancellationSettled })
      } finally {
        clearTimeout(timer)
        abort.abort(new Error('M0 probe finished.'))
      }
    })

    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const port = new URL(address).port
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'm0-host-probe.json'), JSON.stringify({ port }), { mode: 0o600 })
    ctx.logger('m0-host-probe').info('Isolated M0 Host probe is ready.')

    return async () => {
      await app.close()
    }
  }, 'isolated M0 Host carrier probe')
}
