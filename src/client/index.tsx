import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'

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
    'write.failed': '配置写入失败，请重试。',
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
    'write.failed': 'Failed to write configuration, please retry.',
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

/* Plugin-scoped styles over --dsw-* design tokens; injected once at
 * materialization, exactly like a compiled css-module side effect. The row
 * vocabulary mirrors the shipped General settings page: a full-width flex
 * column of rows separated by hairline borders. */
const CSS = `
.dshr-section{flex-direction:column;width:100%;display:flex}
.dshr-row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:16px 0;display:flex}
.dshr-title{font-size:14px;line-height:20px}
.dshr-description{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}
.dshr-alert{color:var(--dsw-alias-state-error-primary);margin-top:4px;font-size:12px;line-height:18px}
.dshr-text{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;padding:16px 0;font-size:14px;line-height:22px}
.dshr-qrBox{width:184px;height:184px;background:#fff;border-radius:var(--dsw-radius-md);padding:8px;flex:none}
.dshr-code{font-size:22px;letter-spacing:8px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dshr-actions{display:flex;gap:8px;flex:none}
`

function injectCss(): void {
  if (typeof document === 'undefined') return
  const tagId = '@suj1e/dsh-remote/client.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@suj1e/dsh-remote'
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
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
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
}

interface SectionProps {
  t: (key: string) => string
  form: ConfigFormController
  fallbackPort: number
}

function Section({ t, form, fallbackPort }: SectionProps): ReactElement {
  const [snap, setSnap] = useState(() => form.getSnapshot())
  useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form])

  const config = snap.value as { enabled?: boolean; port?: number } | undefined
  const loaded = snap.status !== 'loading'
  const enabled = loaded && config?.enabled !== false
  const port = typeof config?.port === 'number' && config.port > 0 ? config.port : fallbackPort
  const { state, unreachable } = useAdminState(enabled, port)

  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const flip = (next: boolean): void => {
    setFailed(false)
    setBusy(true)
    form
      .set('enabled', next)
      .then((accepted) => {
        if (!accepted) setFailed(true)
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }

  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const runAction = (path: string, body?: unknown): void => {
    setActionError(undefined)
    adminAction(port, path, body).catch((error: Error) => setActionError(error.message))
  }

  return (
    <div className="dshr-section">
      {!loaded ? (
        <div className="dshr-text">{t('status.loading')}</div>
      ) : !snap.writable ? (
        <div className="dshr-text">{t('status.unwritable')}</div>
      ) : (
        <div className="dshr-row">
          <div>
            <div className="dshr-title">{t('allow')}</div>
            <div className="dshr-description">{t('description')}</div>
            <div className="dshr-description">{t('allow.hint')}</div>
            {failed ? (
              <div className="dshr-alert" role="alert">
                {t('write.failed')}
              </div>
            ) : null}
          </div>
          <Switch checked={enabled} disabled={busy} label={t('allow')} onChange={flip} />
        </div>
      )}

      {enabled ? (
        unreachable || !state ? (
          <div className="dshr-row">
            <div>
              <div className="dshr-title">{t('allow')}</div>
              <div className="dshr-description">{t('qr.unreachable')}</div>
            </div>
          </div>
        ) : (
          <>
            <div className="dshr-row">
              <div style={{ minWidth: 0 }}>
                <div className="dshr-title">{t('qr.title')}</div>
                <div className="dshr-description" style={{ marginTop: 10 }}>
                  {t('qr.code')} <span className="dshr-code">{state.pairingCode}</span>
                </div>
                <div className="dshr-description">
                  {t('qr.addresses')}：{state.server.addresses.map((a) => `${a}:${state.server.port}`).join('、')}
                </div>
                <div style={{ marginTop: 10 }}>
                  <Button variant="outline" onClick={() => runAction('/v1/admin/rotate-code')}>
                    {t('qr.rotate')}
                  </Button>
                </div>
              </div>
              <div
                className="dshr-qrBox"
                // Server-generated SVG from our own qrcode output; no user input flows into it.
                dangerouslySetInnerHTML={{ __html: state.pairingQrSvg }}
              />
            </div>

            <div className="dshr-text">{t('devices').replace('{n}', String(state.devices.length))}</div>
            {state.devices.length === 0 ? (
              <div className="dshr-row">
                <div className="dshr-description">{t('devices.empty')}</div>
              </div>
            ) : (
              state.devices.map((device) => (
                <div className="dshr-row" key={device.id}>
                  <div style={{ minWidth: 0 }}>
                    <div className="dshr-title">{device.name}</div>
                    <div className="dshr-description">
                      {t('devices.createdAt')} {new Date(device.createdAt).toLocaleString()} · {t('devices.lastSeenAt')}{' '}
                      {new Date(device.lastSeenAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="dshr-actions">
                    <Button variant="ghost" onClick={() => runAction('/v1/admin/revoke', { deviceId: device.id })}>
                      {t('devices.revoke')}
                    </Button>
                  </div>
                </div>
              ))
            )}
            {actionError ? (
              <div className="dshr-row">
                <div className="dshr-alert" role="alert">
                  {actionError}
                </div>
              </div>
            ) : null}
          </>
        )
      ) : null}
    </div>
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
 * the allow-remote toggle (a primitives Switch over the native plugin config
 * form, so flipping it stops/starts the server via a fiber remount) plus the
 * pairing QR, pairing code, host addresses, and device roster. Page props are
 * one stable object, matching how every shipped settings section feeds its
 * occupant.
 */
export function apply(ctx: ClientContext, config: ClientConfig = {}): void {
  injectCss()
  ctx.effect(() => ctx.locale.register(NS, locale))
  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get(ENTRY_ID)
  // One stable props object: a fresh literal per inject() call remounts the
  // occupant on every host-page render and eats interaction state.
  const props = { t, form, fallbackPort: config.port ?? DEFAULT_PORT }

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'mobile-remote',
        order: 400,
        label: () => t('nav'),
        locale: NS,
        inject: () => props,
      },
      Section,
    ),
  )
}

export const inject = ['slots', 'locale', 'configForms']
