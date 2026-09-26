import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Fastify from 'fastify'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { Readable } from 'node:stream'
import test from 'node:test'

/**
 * M0 carrier probe: the Connection service and Fastify are real pinned packages,
 * while the endpoint handler is synthetic. This is not a DSH Gateway/Host pass.
 */
test('Fastify forwards RPC through the official shared FetchHandler and preserves multipart bytes', async (t) => {
  const root = new Context()
  const hostFiber = await root.plugin((ctx) => {
    new HostConnectionService(ctx, [], { isAuthenticated: () => true })
    ctx.connection.rpc.intercept(
      '/api',
      (endpoint) => endpoint === 'workspaceFiles/readBytes',
      async (endpoint, payload) => ({
        ok: true,
        value: { endpoint, path: payload.path, data: null },
        attachments: [{ path: ['data'], bytes: new Uint8Array([0x00, 0x7f, 0x80, 0xff]) }],
      }),
    )
  })
  const fetchHandler = root.connection.createSharedFetchHandler('/api')
  const app = Fastify()

  app.post('/api/:namespace/:method', async (request, reply) => {
    const pathname = `/api/${request.params.namespace}/${request.params.method}`
    const fetchRequest = new Request(`http://${request.hostname}${pathname}`, {
      method: request.method,
      headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
      body: JSON.stringify(request.body),
    })
    const response = await fetchHandler.fetch(fetchRequest)
    reply.status(response.status)
    for (const [name, value] of response.headers) reply.header(name, value)
    return reply.send(Buffer.from(await response.arrayBuffer()))
  })

  t.after(async () => {
    await app.close()
    await hostFiber.dispose()
    await root.fiber.dispose()
  })

  const response = await app.inject({
    method: 'POST',
    url: '/api/workspaceFiles/readBytes',
    headers: { 'content-type': 'application/json' },
    payload: {
      type: 'client-request',
      rpcId: 'm0-carrier-001',
      method: 'workspaceFiles/readBytes',
      payload: { path: '/isolated/fixture.bin' },
    },
  })

  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'], /^multipart\/form-data; boundary=/)

  const multipart = await new Response(response.rawPayload, { headers: response.headers }).formData()
  const metadata = JSON.parse(multipart.get('metadata'))
  const bytes = new Uint8Array(await multipart.get('bytes-0').arrayBuffer())

  assert.deepEqual(metadata, {
    type: 'server-response',
    rpcId: 'm0-carrier-001',
    result: {
      ok: true,
      value: { endpoint: 'workspaceFiles/readBytes', path: '/isolated/fixture.bin', data: null },
    },
    attachments: [{ path: ['data'], codec: 'bytes', part: 'bytes-0' }],
  })
  assert.deepEqual([...bytes], [0x00, 0x7f, 0x80, 0xff])
})

test('Fastify passes raw upload bytes to the official streaming Fetch route', async (t) => {
  const root = new Context()
  const hostFiber = await root.plugin((ctx) => {
    new HostConnectionService(ctx, [], { isAuthenticated: () => true })
    ctx.connection.fetch.register({
      path: '/api/session/uploadFileBinary',
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        const chunks = []
        for await (const chunk of request.body) chunks.push(Buffer.from(chunk))
        const bytes = Buffer.concat(chunks)
        const url = new URL(request.url)
        return Response.json({
          sessionId: url.searchParams.get('sessionId'),
          name: url.searchParams.get('name'),
          bytesHex: bytes.toString('hex'),
        })
      },
    })
  })
  const fetchHandler = root.connection.createSharedFetchHandler('/api')
  const app = Fastify()

  app.addContentTypeParser('application/octet-stream', (request, payload, done) => {
    done(null, payload)
  })
  app.post('/api/session/uploadFileBinary', async (request, reply) => {
    const url = new URL(request.url, `http://${request.hostname}`)
    assert.equal(
      fetchHandler.requestBodyMode({ method: request.method, url }),
      'streaming',
    )
    const fetchRequest = new Request(url, {
      method: request.method,
      headers: { 'content-type': request.headers['content-type'] ?? 'application/octet-stream' },
      body: Readable.toWeb(request.body),
      duplex: 'half',
    })
    const response = await fetchHandler.fetch(fetchRequest)
    reply.status(response.status)
    for (const [name, value] of response.headers) reply.header(name, value)
    return reply.send(Buffer.from(await response.arrayBuffer()))
  })

  t.after(async () => {
    await app.close()
    await hostFiber.dispose()
    await root.fiber.dispose()
  })

  const response = await app.inject({
    method: 'POST',
    url: '/api/session/uploadFileBinary?sessionId=session-m0&name=fixture.bin',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from([0x00, 0x7f, 0x80, 0xff]),
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    sessionId: 'session-m0',
    name: 'fixture.bin',
    bytesHex: '007f80ff',
  })
})
