import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import Fastify from 'fastify'

export const inject = ['connection']

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

    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const port = new URL(address).port
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'm0-host-probe.json'), JSON.stringify({ port }), { mode: 0o600 })
    ctx.logger('m0-host-probe').info('Isolated read-only Host probe is ready.')

    return async () => {
      await app.close()
    }
  }, 'isolated M0 Host carrier probe')
}
