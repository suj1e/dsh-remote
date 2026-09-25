# dsh-remote

让 iPhone App 通过局域网远程使用 Mac 上运行的 DeepSeek Harness（DSH）。

DSH 插件（Cordis bundle），在 Host 进程内开启一个独立的 HTTP+WebSocket 服务，把 DSH 的 Remote API——与桌面 Web GUI 完全相同的 `typertGateway` 调用面——代理给配对后的手机设备。手机端 iOS App 在独立仓库开发，对接契约见 [PROTOCOL.md](./PROTOCOL.md)。

## 功能

- **配对**：设置页内嵌二维码与 6 位配对码（iOS App 扫码或手输换取设备令牌，SHA-256 摘要落盘，可随时吊销）
- **会话**：列表实时增删/状态推送（`api-session/*` 事件）、实时消息流（`session/follow`）、发送消息（`session/prompt`，幂等）、取消（`session/cancel`）
- **审批**：`$events` 流转发审批与用户提问（waterfall），手机作答经 `$events/result` 回传，与桌面端先答先得
- **桌面 GUI**（client 半边）：设置页「手机远程」一个入口——「允许远程连接」开关（走原生插件配置表单，关闭立即停止监听并断开手机，持久化）+ 配对二维码/配对码/本机地址 + 已配对设备管理（吊销/换码）
- **多主机**：App 端按档案管理多台 Mac（每台一份地址+令牌），纯客户端能力，协议无需扩展（客户端模型见 PROTOCOL.md §6）

## 安装

要求 DSH ≥ 0.1.7-rc.2（peer 版本精确对齐，安装器会校验）。

```bash
# 从 npm 安装（推荐）
dsh plugin install @suj1e/dsh-remote
# 或在 Web GUI：设置 → 插件 → 安装外部插件，填包名

# 本地路径安装（开发）
dsh plugin install /path/to/dsh-remote
```

> **首次安装后需重启一次 DSH**：client 半边（设置页/侧栏按钮）的包元数据在进程内有缓存；重启后即出现。

## 发布（CI 流水线）

GitHub Actions 两条流水线：

- **CI**（`.github/workflows/ci.yml`）：push/PR 时在 ubuntu + macOS 上 install → build → test → `npm pack --dry-run` 校验产物
- **Release**（`.github/workflows/release.yml`）：推送 `v*` tag 时校验 tag 与 package.json 版本一致 → 测试 → 构建 → `npm publish --access public --provenance`

发布步骤：

```bash
# 一次性准备
# 1. npmjs.com 确认账号（scope 必须与 npm 用户名一致，即 @suj1e）
# 2. 生成 Automation 类型的 Access Token，配置到仓库 Settings → Secrets → NPM_TOKEN

# 每次发版
npm version patch   # 或 minor / major
git push --follow-tags
# CI 自动发布，DSH 侧更新：dsh plugin install @suj1e/dsh-remote
```

## 配置

入口 `dsh-remote`（cordis.patch.yml / 插件页可改）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启动监听 |
| `port` | `8747` | 监听端口（`0` = 系统分配） |
| `bind` | `0.0.0.0` | 监听地址 |
| `allowedEndpoints` | `['session/*', '$events/*']` | 手机可调用的 Remote 端点白名单 |

状态与设备数据持久化在 `$DSH_HOME/mobile-remote/devices.json`。

## 安全模型

- **本地 = 可信**：配对页与管理 API 仅接受回环地址（与桌面 GUI 同等姿态）
- **局域网 = 需令牌**：除 `/v1/pair`（配对码 + 限速）外全部要求 Bearer 令牌；令牌只存哈希
- **明文 HTTP**：v1 不含 TLS。仅限可信网络使用；外出访问请经 Tailscale 等组网（其隧道提供加密）
- 配对码可在配对页随时更换；设备可单独吊销

## 开发

```bash
pnpm install
pnpm run build   # tsdown: lib/index.js (Host) + lib/client.js (浏览器)
pnpm test        # node:test：配对/鉴权/白名单/WS 帧代理/桩网关端到端
```

源码结构：

```
src/index.ts            Host 插件入口（inject typertGateway，拉起服务器）
src/config.ts           Schemastery 配置
src/server/devices.ts   设备注册表 + 配对码（$DSH_HOME/mobile-remote/）
src/server/auth.ts      Bearer 解析、回环判定、配对限速
src/server/http.ts      HTTP 服务器：配对页 / REST / 管理动作 / WS 升级
src/server/rpc.ts       dispatchRpc 代理 + 端点白名单
src/server/ws.ts        WS 逻辑流多路复用（stream-protocol 帧格式）
src/server/events.ts    api-session/* 事件 → notify 推送
src/server/pair-page.ts 自托管配对页（QR 由 qrcode 生成）
src/client/index.tsx    浏览器半边：设置页 + 侧栏入口
```

架构要点：一元调用走 `ctx.typertGateway.dispatchRpc`，流走 `ctx.typertGateway.wireStream.open`，帧校验复用 `@deepseek-ai/dsh-api-gateway/stream-protocol`——即手机端与桌面浏览器消费**同一条**类型化调用链（严格描述符、参数校验、agent 解析全部由网关完成）。

## 许可

MIT
