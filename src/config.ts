import z from '@deepseek-ai/schemastery'

/**
 * Runtime shape of a volatile config field: schemastery parses set values
 * into stable references read with `.get()`; defaults stay ordinary data.
 * Duck-typed to avoid a direct cosmokit dependency.
 */
export type VolatileRef<T> = { get(): T }

/** Read a config value that may be a volatile reference or plain data. */
export function readVolatile<T>(value: T | VolatileRef<T>): T {
  if (typeof value === 'object' && value !== null && typeof (value as VolatileRef<T>).get === 'function') {
    return (value as VolatileRef<T>).get()
  }
  return value as T
}

/** Validated plugin configuration. */
export interface Config {
  /** Whether the mobile server listens; volatile — editable live from Settings. */
  enabled: boolean | VolatileRef<boolean>
  /** TCP port to listen on; 0 requests an OS-assigned port. */
  port: number
  /** Bind address for the listener. */
  bind: string
  /** Remote endpoint patterns the mobile client may call. */
  allowedEndpoints: string[]
}

/** Default mobile endpoint whitelist: session conversation surface plus the forwarded Host event stream. */
export const DEFAULT_ALLOWED_ENDPOINTS = ['session/*', '$events/*', 'workspace/*']

export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .volatile()
    .description('允许远程连接：关闭立即停止监听并断开手机（可在设置页实时切换）。'),
  port: z.number().default(8747).step(1).min(0).max(65535).description('TCP port to listen on (0 = OS-assigned).'),
  bind: z.string().default('0.0.0.0').description('Bind address for the listener.'),
  allowedEndpoints: z
    .array(z.string())
    .default(DEFAULT_ALLOWED_ENDPOINTS)
    .description('Remote endpoint patterns the mobile client may invoke, e.g. "session/*".'),
})
