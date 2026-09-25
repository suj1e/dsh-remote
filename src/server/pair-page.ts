import QRCode from 'qrcode'
import { createHash } from 'node:crypto'

export interface PairPageData {
  hostName: string
  port: number
  addresses: string[]
  pairingCode: string
  devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number }>
}

const PAGE_SCRIPT = `
function refresh() {
  fetch('/v1/admin/state').then(r => r.json()).then(state => {
    location.hash || history.replaceState(null, '', '#' + state.pairingCode)
  }).catch(() => {})
}
document.addEventListener('click', async (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (target.id === 'rotate') {
    await fetch('/v1/admin/rotate-code', { method: 'POST' })
    location.reload()
  }
  const revoke = target.dataset.revoke
  if (revoke) {
    await fetch('/v1/admin/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: revoke }),
    })
    location.reload()
  }
})
`

/** CSP digest for the inline page script. */
const PAGE_SCRIPT_SHA = createHash('sha256').update(PAGE_SCRIPT).digest('base64')

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export async function renderPairPage(data: PairPageData): Promise<string> {
  const address = data.addresses[0] ?? '127.0.0.1'
  const deepLink = `dsh-remote://pair?host=${encodeURIComponent(address)}&port=${data.port}&code=${data.pairingCode}`
  const qr = await QRCode.toString(deepLink, { type: 'svg', margin: 1, width: 220 })
  const devices = data.devices
    .map(
      (device) => `<tr>
        <td>${escapeHtml(device.name)}</td>
        <td>${new Date(device.createdAt).toLocaleString()}</td>
        <td>${new Date(device.lastSeenAt).toLocaleString()}</td>
        <td><button class="danger" data-revoke="${escapeHtml(device.id)}">吊销</button></td>
      </tr>`,
    )
    .join('')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 手机远程 · 配对</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; margin: 0; padding: 32px;
         max-width: 720px; margin-inline: auto; }
  h1 { font-size: 20px; }
  .card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 12px;
          padding: 20px; margin-block: 16px; }
  .qr { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
  .qr svg { border-radius: 8px; background: #fff; padding: 8px; }
  code.big { font-size: 32px; letter-spacing: 8px; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  button { padding: 6px 14px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
           background: transparent; color: inherit; cursor: pointer; }
  button.danger { color: #d04545; border-color: #d04545; }
  .muted { opacity: 0.65; }
  ul.addresses { margin: 4px 0; padding-left: 18px; }
</style>
</head>
<body>
<h1>DSH 手机远程</h1>
<div class="card">
  <div class="qr">
    ${qr}
    <div>
      <div class="muted">配对码（也可在 App 内手动输入）</div>
      <code class="big">${escapeHtml(data.pairingCode)}</code>
      <div class="muted" style="margin-top:8px">深链：${escapeHtml(deepLink)}</div>
      <button id="rotate" style="margin-top:12px">更换配对码</button>
    </div>
  </div>
</div>
<div class="card">
  <strong>本机地址</strong>
  <ul class="addresses">${data.addresses.map((a) => `<li><code>${escapeHtml(a)}:${data.port}</code></li>`).join('')}</ul>
  <span class="muted">手机与 Mac 需在同一网络（或经 Tailscale 等组网）。服务仅在启用本插件时开放。</span>
</div>
<div class="card">
  <strong>已配对设备（${data.devices.length}）</strong>
  <table>
    <thead><tr><th>名称</th><th>配对时间</th><th>最后在线</th><th></th></tr></thead>
    <tbody>${devices || '<tr><td colspan="4" class="muted">暂无设备，用 App 扫码配对</td></tr>'}</tbody>
  </table>
</div>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`
}

export const pairPageCsp = `script-src 'sha256-${PAGE_SCRIPT_SHA}'`
