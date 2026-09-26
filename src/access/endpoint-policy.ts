import { readFileSync } from 'node:fs'
import { parseRemoteEventResult } from '@deepseek-ai/dsh-api-gateway/stream-protocol'

type ContractPolicy = {
  endpointPolicy: {
    unary: string[]
    conditionallyAllowed: string[]
    streams: string[]
    gatewayInternalUnary: string[]
    fetchRoutes: Array<{ method: string; path: string; contentType: string }>
  }
}

const contract = JSON.parse(
  readFileSync(new URL('../../contract/contract-v1.json', import.meta.url), 'utf8'),
) as ContractPolicy

const unaryEndpoints = new Set(contract.endpointPolicy.unary)
const internalEndpoints = new Set(contract.endpointPolicy.gatewayInternalUnary)
const streamEndpoints = new Set(contract.endpointPolicy.streams)

export type PolicyDenial =
  | 'method-not-allowed'
  | 'malformed-endpoint'
  | 'endpoint-not-allowed'
  | 'gateway-internal-only'
  | 'settings-mutation-not-enabled'
  | 'command-not-allowed'
  | 'invalid-fetch-route'
  | 'invalid-upload-query'

export type PolicyDecision =
  | { allowed: true; endpoint: string }
  | { allowed: false; denial: PolicyDenial }

export interface PermissionContext {
  /** Catalog values read from this same Host via permissionPresets/catalog. */
  presetValues: ReadonlySet<string>
}

function deny(denial: PolicyDenial): PolicyDecision {
  return { allowed: false, denial }
}

function parseEndpointPath(path: string): string | undefined {
  if (!path.startsWith('/api/')) return undefined
  if (path.includes('?') || path.includes('#') || path.includes('%')) return undefined

  const segments = path.slice('/api/'.length).split('/')
  if (segments.length !== 2) return undefined
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return undefined
  return `${segments[0]}/${segments[1]}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function isOfficialEventResultPayload(payload: unknown): boolean {
  const envelope = record(payload)
  if (!envelope || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'args')) return false
  try {
    parseRemoteEventResult(envelope.args)
    return true
  } catch {
    return false
  }
}

function authorizePermissionCommand(payload: unknown, context: PermissionContext): boolean {
  const envelope = record(payload)
  const args = record(envelope?.args)
  const line = args?.line
  const agentId = args?.agentId
  const attachments = args?.submittedAttachments

  if (typeof line !== 'string' || typeof agentId !== 'string' || agentId.length === 0) return false
  if (!Array.isArray(attachments) || attachments.length !== 0) return false

  const tokens = line.trim().split(/\s+/)
  if (tokens[0] !== '/permission') return false
  if (tokens.length === 1) return true
  if (tokens.length !== 2) return false
  return context.presetValues.has(tokens[1] ?? '')
}

/**
 * Authorize only an exact official Remote unary endpoint. The official DSH
 * shared FetchHandler remains responsible for the business RPC/envelope.
 */
export function authorizeUnaryRequest(input: {
  method: string
  path: string
  payload: unknown
  permissionContext: PermissionContext
}): PolicyDecision {
  if (input.method !== 'POST') return deny('method-not-allowed')

  const endpoint = parseEndpointPath(input.path)
  if (!endpoint) return deny('malformed-endpoint')
  if (internalEndpoints.has(endpoint)) {
    if (endpoint === '$events/result' && isOfficialEventResultPayload(input.payload)) {
      return { allowed: true, endpoint }
    }
    return deny('gateway-internal-only')
  }
  if (endpoint === 'settings/mutate') return deny('settings-mutation-not-enabled')
  if (!unaryEndpoints.has(endpoint)) return deny('endpoint-not-allowed')

  if (endpoint === 'commands/execute' && !authorizePermissionCommand(input.payload, input.permissionContext)) {
    return deny('command-not-allowed')
  }

  return { allowed: true, endpoint }
}

/** Match the official Remote mux stream descriptor exactly; never prefix-match. */
export function authorizeStreamEndpoint(endpoint: string): PolicyDecision {
  if (!streamEndpoints.has(endpoint)) return deny('endpoint-not-allowed')
  return { allowed: true, endpoint }
}

/**
 * Match the sole installed-source-verified raw upload route and its narrow
 * query grammar before forwarding the request to the official Fetch route.
 */
export function authorizeFetchRoute(input: {
  method: string
  pathAndQuery: string
  contentType: string | undefined
}): PolicyDecision {
  const route = contract.endpointPolicy.fetchRoutes.find((candidate) => candidate.method === input.method)
  if (!route) return deny('method-not-allowed')

  let url: URL
  try {
    url = new URL(input.pathAndQuery, 'http://dsh-remote.invalid')
  } catch {
    return deny('invalid-fetch-route')
  }
  if (url.pathname !== route.path) return deny('invalid-fetch-route')
  if ((input.contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() !== route.contentType) {
    return deny('invalid-fetch-route')
  }

  const sessionIds = url.searchParams.getAll('sessionId')
  const names = url.searchParams.getAll('name')
  const queryKeys = [...url.searchParams.keys()]
  if (sessionIds.length !== 1 || sessionIds[0]?.trim() === '') return deny('invalid-upload-query')
  if (names.length > 1 || queryKeys.some((key) => key !== 'sessionId' && key !== 'name')) {
    return deny('invalid-upload-query')
  }
  return { allowed: true, endpoint: route.path }
}
