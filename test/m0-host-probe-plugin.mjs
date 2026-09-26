import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { parseRemoteStreamClientMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'

export const inject = ['connection', 'typertGateway', 'dshRemoteControl', 'agents', 'approval', 'userQuestions']

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
    await app.register(websocket, { options: { maxPayload: 16 * 1024 } })
    const questionRuns = new Map()
    const approvalRuns = new Map()

    const activeMuxStreams = new Set()
    const sendFrame = (socket, frame) => new Promise((resolve, reject) => {
      if (socket.readyState !== 1) return reject(new Error('M0 probe WebSocket is not open.'))
      socket.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve())
    })

    const pumpMuxStream = async (socket, message, active) => {
      try {
        const source = await ctx.typertGateway.wireStream.open(
          message.endpoint,
          message.payload,
          { async *[Symbol.asyncIterator]() {} },
          undefined,
          active.abort.signal,
        )
        for await (const value of source) {
          await sendFrame(socket, { type: 'item', streamId: message.streamId, value })
        }
        if (!active.abort.signal.aborted) {
          await sendFrame(socket, { type: 'end', streamId: message.streamId })
        }
      } catch (error) {
        if (!active.abort.signal.aborted && socket.readyState === 1) {
          await sendFrame(socket, {
            type: 'error',
            streamId: message.streamId,
            error: ctx.typertGateway.wireStream.failure(error),
          }).catch(() => {})
        }
      } finally {
        active.connectionStreams.delete(message.streamId)
        activeMuxStreams.delete(active)
      }
    }

    app.get('/api/remote.mux', { websocket: true }, (socket) => {
      const connectionStreams = new Map()
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          socket.close(1003, 'text messages required')
          return
        }

        let message
        try {
          message = parseRemoteStreamClientMessage(data.toString())
        } catch {
          socket.close(1008, 'invalid Remote stream request')
          return
        }

        if (message.type === 'cancel') {
          connectionStreams.get(message.streamId)?.abort.abort(new Error('Remote stream cancelled'))
          return
        }
        if (message.type !== 'open' || message.endpoint !== '$events' || connectionStreams.has(message.streamId)) {
          socket.close(1008, 'M0 probe only accepts unique $events open frames and cancel frames')
          return
        }

        const active = { abort: new AbortController(), connectionStreams, streamId: message.streamId }
        connectionStreams.set(message.streamId, active)
        activeMuxStreams.add(active)
        void pumpMuxStream(socket, message, active)
      })
      socket.on('close', () => {
        for (const active of connectionStreams.values()) active.abort.abort(new Error('Remote stream socket closed'))
      })
    })

    app.get('/m0/mux/probe-state', async () => ({
      activeStreamIds: [...activeMuxStreams].map(({ streamId }) => streamId),
    }))

    app.post('/m0/events/question-runs', async (request, reply) => {
      const runId = randomUUID()
      const sessionId = randomUUID()
      const handle = await ctx.agents.create({ sessionId })
      const abort = new AbortController()
      const record = { handle, abort, result: undefined, promise: undefined }
      record.promise = ctx.userQuestions.ask({
        agent: handle.agent,
        questions: request.body?.questions,
        signal: abort.signal,
      }).then(
        (value) => ({ ok: true, value }),
        (error) => ({
          ok: false,
          error: {
            name: typeof error?.name === 'string' ? error.name : 'Error',
            ...(typeof error?.code === 'string' ? { code: error.code } : {}),
          },
        }),
      ).then((result) => {
        record.result = result
        return result
      })
      questionRuns.set(runId, record)
      return reply.code(202).send({ runId, agentId: handle.agent.id })
    })

    app.get('/m0/events/question-runs/:runId', async (request, reply) => {
      const record = questionRuns.get(request.params.runId)
      if (!record) return reply.code(404).send({ error: 'unknown question run' })
      if (!record.result) return reply.code(202).send({ status: 'pending' })
      return reply.send({ status: 'settled', ...record.result })
    })

    app.post('/m0/events/question-runs/:runId/cancel', async (request, reply) => {
      const record = questionRuns.get(request.params.runId)
      if (!record) return reply.code(404).send({ error: 'unknown question run' })
      record.abort.abort(new Error('M0 Host question cancellation probe.'))
      return reply.send({ accepted: true })
    })

    app.delete('/m0/events/question-runs/:runId', async (request, reply) => {
      const record = questionRuns.get(request.params.runId)
      if (!record) return reply.code(404).send({ error: 'unknown question run' })
      if (!record.result) record.abort.abort(new Error('M0 Host question run disposed.'))
      await record.promise
      await record.handle.dispose()
      questionRuns.delete(request.params.runId)
      return reply.send({ disposed: true })
    })

    app.post('/m0/events/approval-runs', async (request, reply) => {
      const runId = randomUUID()
      const sessionId = randomUUID()
      const handle = await ctx.agents.create({ sessionId })
      const turn = 1
      handle.agent.session.append('turn/start', { turn })
      const abort = new AbortController()
      const record = { handle, abort, result: undefined, promise: undefined }
      record.promise = ctx.approval.request({
        agent: handle.agent,
        toolName: 'm0-probe-tool',
        callId: 'm0-probe-call',
        reason: 'Approve the isolated M0 protocol probe.',
        signal: abort.signal,
      }).then(
        (value) => ({ ok: true, value }),
        (error) => ({
          ok: false,
          error: {
            name: typeof error?.name === 'string' ? error.name : 'Error',
            ...(typeof error?.code === 'string' ? { code: error.code } : {}),
          },
        }),
      ).then((result) => {
        handle.agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
        const audit = handle.agent.session.snapshotEvents()
          .filter((event) => event.type === 'approval/asked' || event.type === 'approval/decided')
          .map((event) => ({ type: event.type, data: event.data }))
        record.result = { ...result, audit }
        return record.result
      })
      approvalRuns.set(runId, record)
      return reply.code(202).send({ runId, agentId: handle.agent.id })
    })

    app.get('/m0/events/approval-runs/:runId', async (request, reply) => {
      const record = approvalRuns.get(request.params.runId)
      if (!record) return reply.code(404).send({ error: 'unknown approval run' })
      if (!record.result) return reply.code(202).send({ status: 'pending' })
      return reply.send({ status: 'settled', ...record.result })
    })

    app.post('/m0/events/approval-runs/:runId/cancel', async (request, reply) => {
      const record = approvalRuns.get(request.params.runId)
      if (!record) return reply.code(404).send({ error: 'unknown approval run' })
      record.abort.abort(new Error('M0 Host approval cancellation probe.'))
      return reply.send({ accepted: true })
    })

    app.delete('/m0/events/approval-runs/:runId', async (request, reply) => {
      const record = approvalRuns.get(request.params.runId)
      if (!record) return reply.code(404).send({ error: 'unknown approval run' })
      if (!record.result) record.abort.abort(new Error('M0 Host approval run disposed.'))
      await record.promise
      await record.handle.dispose()
      approvalRuns.delete(request.params.runId)
      return reply.send({ disposed: true })
    })

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
      '/api/settings/describe',
      '/api/settings/mutate',
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
    const pairing = ctx.dshRemoteControl.openPairingWindow()
    const remoteAddress = ctx.dshRemoteControl.listenAddress
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'm0-host-probe.json'), JSON.stringify({ port, remoteAddress, pairingCode: pairing.code }), { mode: 0o600 })
    ctx.logger('m0-host-probe').info('Isolated M0 Host probe is ready.')

    return async () => {
      for (const record of questionRuns.values()) {
        if (!record.result) record.abort.abort(new Error('M0 probe plugin is unloading.'))
      }
      for (const record of approvalRuns.values()) {
        if (!record.result) record.abort.abort(new Error('M0 probe plugin is unloading.'))
      }
      await Promise.all([...questionRuns.values()].map(async (record) => {
        await record.promise
        await record.handle.dispose()
      }))
      await Promise.all([...approvalRuns.values()].map(async (record) => {
        await record.promise
        await record.handle.dispose()
      }))
      await app.close()
    }
  }, 'isolated M0 Host carrier probe')
}
