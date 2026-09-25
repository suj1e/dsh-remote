import { useEffect, useState, type ReactElement } from 'react'

const NS = 'dshRemote'

interface ClientConfig {
  enabled?: boolean
  port?: number
}

interface SectionProps {
  port: number
  enabled: boolean
  t: (key: string) => string
}

interface Locale {
  zh: Record<string, string>
  en: Record<string, string>
}

const locale: Locale = {
  zh: {
    'nav': '手机远程',
    'title': '手机远程',
    'description': '通过配对的 iPhone App 在局域网内远程使用此 DSH。',
    'status.on': '服务运行中',
    'status.off': '服务未启动（插件配置已关闭）',
    'open-page': '打开配对页',
    'open-page.hint': '配对码、二维码与已配对设备管理都在本地配对页中。',
    'port': '端口',
  },
  en: {
    'nav': 'Mobile Remote',
    'title': 'Mobile Remote',
    'description': 'Use this DSH from a paired iPhone app over the LAN.',
    'status.on': 'Server running',
    'status.off': 'Server stopped (disabled by plugin config)',
    'open-page': 'Open pairing page',
    'open-page.hint': 'Pairing code, QR code, and paired devices live on the local page.',
    'port': 'Port',
  },
}

function pairPageUrl(port: number): string {
  return `http://127.0.0.1:${port}/`
}

function Section({ port, enabled, t }: SectionProps): ReactElement {
  const [reachable, setReachable] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    const probe = () => {
      fetch(pairPageUrl(port), { mode: 'no-cors' })
        .then(() => !cancelled && setReachable(true))
        .catch(() => !cancelled && setReachable(false))
    }
    probe()
    const timer = setInterval(probe, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [port])

  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <p style={{ margin: 0, opacity: 0.8 }}>{t('description')}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: enabled && reachable !== false ? '#3fb96f' : '#c9c9c9',
            display: 'inline-block',
          }}
        />
        <span>{enabled ? t('status.on') : t('status.off')}</span>
        <span style={{ opacity: 0.65 }}>
          {t('port')}: {port}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <button
          type="button"
          onClick={() => window.open(pairPageUrl(port), '_blank', 'noopener')}
          style={{ justifySelf: 'start' }}
        >
          {t('open-page')}
        </button>
        <span style={{ opacity: 0.65, fontSize: '0.9em' }}>{t('open-page.hint')}</span>
      </div>
    </section>
  )
}

function SidebarAction({ port, t }: { port: number; t: (key: string) => string }): ReactElement {
  return (
    <button
      type="button"
      title={t('nav')}
      aria-label={t('nav')}
      onClick={() => window.open(pairPageUrl(port), '_blank', 'noopener')}
    >
      {'📱'}
    </button>
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
}

/**
 * Browser half of dsh-remote: a Settings page and a sidebar shortcut that
 * surface the local pairing page served by the plugin's own HTTP listener.
 */
export function apply(ctx: ClientContext, config: ClientConfig = {}): void {
  const port = typeof config.port === 'number' && config.port > 0 ? config.port : 8747
  const enabled = config.enabled !== false

  ctx.effect(() => ctx.locale.register(NS, locale))
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'mobile-remote',
        order: 400,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ port, enabled, t }),
      },
      Section,
    ),
  )

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'mobile-remote',
        order: 500,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ port, t }),
      },
      SidebarAction,
    ),
  )
}

export const inject = ['slots', 'locale']
