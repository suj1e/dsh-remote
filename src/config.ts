import z from '@deepseek-ai/schemastery'

/** Validated plugin configuration. */
export interface Config {
  /** Start the mobile remote server when the plugin loads. */
  enabled: boolean
  /** TCP port to listen on; 0 requests an OS-assigned port. */
  port: number
  /** Bind address for the listener. */
  bind: string
  /** Remote endpoint patterns the mobile client may call. */
  allowedEndpoints: string[]
}

/** Default mobile endpoint whitelist: session conversation surface plus the forwarded Host event stream. */
export const DEFAULT_ALLOWED_ENDPOINTS = ['session/*', '$events/*']

export const Config = z.object({
  enabled: z.boolean().default(true).description('Start the mobile remote server when the plugin loads.'),
  port: z.number().default(8747).step(1).min(0).max(65535).description('TCP port to listen on (0 = OS-assigned).'),
  bind: z.string().default('0.0.0.0').description('Bind address for the listener.'),
  allowedEndpoints: z
    .array(z.string())
    .default(DEFAULT_ALLOWED_ENDPOINTS)
    .description('Remote endpoint patterns the mobile client may invoke, e.g. "session/*".'),
})
