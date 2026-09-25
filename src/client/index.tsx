import { useCallback, useEffect, useState, type ReactElement } from 'react'

const NS = 'dshRemote'
const ENTRY_ID = 'dsh-remote'
const DEFAULT_PORT = 8747

interface ClientConfig {
  port?: number
}

/** Slice of the shared settings form this page drives (dsh-client-ui-settings). */
interface ConfigFormController {
  getSnapshot(): { status: string; value?: unknown; writable: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}

interface Locale {
  zh: Record<string, string>
  en: Record<string, string>
}

const locale: Locale = {
  zh: {
    'nav': '手机远程',
    'description': '通过配对的 iPhone App 在局域网内远程使用此 DSH。',
    'allow': '允许远程连接',
    'allow.hint': '关闭后立即停止监听并断开已连接的手机；重新开启后恢复。',
    'status.loading': '正在读取配置…',
    'status.unwritable': '当前页面无法修改配置（仅本机页面可写）。',
    'qr.title': '扫码配对',
    'qr.unreachable': '服务已开启但暂时不可达（可能端口被占用或正在重启）。',
    'qr.code': '配对码',
    'qr.rotate': '更换配对码',
    'qr.addresses': '本机地址',
    'devices': '已配对设备（{n}）',
    'devices.name': '名称',
    'devices.createdAt': '配对时间',
    'devices.lastSeenAt': '最后在线',
    'devices.revoke': '吊销',
    'devices.empty': '暂无设备，用 App 扫上方二维码配对',
  },
  en: {
    'nav': 'Mobile Remote',
    'description': 'Use this DSH from a paired iPhone app over the LAN.',
    'allow': 'Allow remote connections',
    'allow.hint': 'Turning this off stops the listener and disconnects phones; turn it back on to resume.',
    'status.loading': 'Loading configuration…',
    'status.unwritable': 'This page cannot edit configuration (local pages only).',
    'qr.title': 'Pair by QR',
    'qr.unreachable': 'The server is enabled but unreachable (port busy or restarting).',
    'qr.code': 'Pairing code',
    'qr.rotate': 'Rotate pairing code',
    'qr.addresses': 'Host addresses',
    'devices': 'Paired devices ({n})',
    'devices.name': 'Name',
    'devices.createdAt': 'Paired at',
    'devices.lastSeenAt': 'Last seen',
    'devices.revoke': 'Revoke',
    'devices.empty': 'No devices yet — scan the QR above from the app',
  },
}

interface AdminState {
  server: { port: number; addresses: string[] }
  pairingCode: string
  pairingQrSvg: string
  devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number }>
}

function useAdminState(enabled: boolean, port: number): { state?: AdminState; unreachable: boolean } {
  const [state, setState] = useState<AdminState | undefined>(undefined)
  const [unreachable, setUnreachable] = useState(false)

  const refresh = useCallback(() => {
    if (!enabled) return
    fetch(`http://127.0.0.1:${port}/v1/admin/state`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((value: AdminState) => {
        setState(value)
        setUnreachable(false)
      })
      .catch(() => setUnreachable(true))
  }, [enabled, port])

  useEffect(() => {
    if (!enabled) {
      setState(undefined)
      setUnreachable(false)
      return
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [enabled, refresh])

  return { state, unreachable }
}

async function adminAction(port: number, path: string, body?: unknown): Promise<void> {
  await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((response) => {
    if (!response.ok) throw new Error(`${path}: ${response.status}`)
  })
}

function Toggle({ on, disabled, label, hint, onChange }: {
  on: boolean
  disabled?: boolean
  label: string
  hint?: string
  onChange: (next: boolean) => void
}): ReactElement {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: disabled ? 'default' : 'pointer' }}>
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint ? <span style={{ opacity: 0.65, fontSize: '0.9em' }}>{hint}</span> : null}
    </div>
  )
}

function Section({ t, form, fallbackPort }: { t: (key: string) => string; form: ConfigFormController; fallbackPort: number }): ReactElement {
  const [snap, setSnap] = useState(() => form.getSnapshot())
  useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form])

  const config = snap.value as { enabled?: boolean; port?: number } | undefined
  const loaded = snap.status !== 'loading'
  const enabled = loaded && config?.enabled !== false
  const port = typeof config?.port === 'number' && config.port > 0 ? config.port : fallbackPort
  const { state, unreachable } = useAdminState(enabled, port)

  const [busy, setBusy] = useState(false)
  const flip = (next: boolean): void => {
    setBusy(true)
    void form
      .set('enabled', next)
      .finally(() => setBusy(false))
  }

  return (
    <section style={{ display: 'grid', gap: 16 }}>
      <p style={{ margin: 0, opacity: 0.8 }}>{t('description')}</p>

      {!loaded ? (
        <span style={{ opacity: 0.65 }}>{t('status.loading')}</span>
      ) : !snap.writable ? (
        <span style={{ opacity: 0.65 }}>{t('status.unwritable')}</span>
      ) : (
        <Toggle
          on={enabled}
          disabled={busy}
          label={t('allow')}
          hint={t('allow.hint')}
          onChange={flip}
        />
      )}

      {enabled ? (
        unreachable || !state ? (
          <span style={{ opacity: 0.65 }}>{t('qr.unreachable')}</span>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
              <div
                style={{ width: 200, height: 200, background: '#fff', borderRadius: 8, padding: 6 }}
                // Server-generated SVG from our own qrcode output; no user input flows into it.
                dangerouslySetInnerHTML={{ __html: state.pairingQrSvg }}
              />
              <div style={{ display: 'grid', gap: 8 }}>
                <strong>{t('qr.title')}</strong>
                <span>
                  {t('qr.code')}：<code style={{ fontSize: 24, letterSpacing: 6, fontWeight: 600 }}>{state.pairingCode}</code>
                </span>
                <span style={{ opacity: 0.65, fontSize: '0.9em' }}>
                  {t('qr.addresses')}：{state.server.addresses.map((a) => `${a}:${state.server.port}`).join('、')}
                </span>
                <button type="button" onClick={() => void adminAction(port, '/v1/admin/rotate-code')}>
                  {t('qr.rotate')}
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <strong>{t('devices').replace('{n}', String(state.devices.length))}</strong>
              <table style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '4px 10px' }}>{t('devices.name')}</th>
                    <th style={{ textAlign: 'left', padding: '4px 10px' }}>{t('devices.createdAt')}</th>
                    <th style={{ textAlign: 'left', padding: '4px 10px' }}>{t('devices.lastSeenAt')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.devices.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ opacity: 0.65, padding: '4px 10px' }}>{t('devices.empty')}</td>
                    </tr>
                  ) : (
                    state.devices.map((device) => (
                      <tr key={device.id}>
                        <td style={{ padding: '4px 10px' }}>{device.name}</td>
                        <td style={{ padding: '4px 10px', opacity: 0.7 }}>{new Date(device.createdAt).toLocaleString()}</td>
                        <td style={{ padding: '4px 10px', opacity: 0.7 }}>{new Date(device.lastSeenAt).toLocaleString()}</td>
                        <td style={{ padding: '4px 10px' }}>
                          <button
                            type="button"
                            onClick={() => void adminAction(port, '/v1/admin/revoke', { deviceId: device.id })}
                          >
                            {t('devices.revoke')}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : null}
    </section>
  )
}

interface SlotsApi {
  inject(slot: string, factory: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface LocaleApi {
  register(ns: string, dicts: Locale): unknown
  bind(ns: string): (key: string) => string
}

interface ClientContext {
  effect(callback: () => unknown): unknown
  slots: SlotsApi
  locale: LocaleApi
  configForms: { get(entryId: string): ConfigFormController }
}

/**
 * Browser half of dsh-remote: one Settings page owning the whole surface —
 * the allow-remote toggle (persisted through the native plugin config form,
 * so flipping it stops/starts the server via a fiber remount) plus the
 * pairing QR, pairing code, host addresses, and device roster.
 */
export function apply(ctx: ClientContext, config: ClientConfig = {}): void {
  ctx.effect(() => ctx.locale.register(NS, locale))
  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get(ENTRY_ID)

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'mobile-remote',
        order: 400,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t, form, fallbackPort: config.port ?? DEFAULT_PORT }),
      },
      Section,
    ),
  )
}

export const inject = ['slots', 'locale', 'configForms']
