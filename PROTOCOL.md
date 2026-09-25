# dsh-remote 手机端协议（v1）

本文档是 iOS App 与 dsh-remote 插件通信的唯一契约。协议分为三部分：

1. **配对**：用桌面配对页上的配对码换取设备令牌
2. **REST**：`/v1/info`（主机信息）与 `/v1/rpc`（一元 Remote 调用）
3. **WebSocket**：`/v1/ws`（Remote 流 + 主机事件推送）

传输为明文 HTTP（v1 定位：可信局域网 / Tailscale 等组网）。除配对外，所有请求都要求 Bearer 令牌。

---

## 1. 基础约定

- 所有请求/响应体均为 UTF-8 JSON。
- 认证方式：`Authorization: Bearer <deviceToken>`。
- 错误响应形如 `{"error": "<code>"}`；`/v1/rpc` 的业务错误在 RemoteResult 信封内（见 3.2）。
- 基地址：配对时从二维码/深链获得，形如 `http://192.168.x.x:8747`。
  二维码内容：`dsh-remote://pair?host=<ip>&port=<port>&code=<6位配对码>`。

## 2. 配对

### POST /v1/pair

```json
{ "code": "146682", "deviceName": "Sujie 的 iPhone" }
```

- 成功 `200`：

```json
{
  "deviceId": "b3b5c868-...",
  "deviceToken": "<64位hex，持久保存到钥匙串>",
  "plugin": { "name": "dsh-remote", "version": "0.1.0" },
  "host": { "name": "MacBook-Pro-2.local", "platform": "darwin" },
  "server": { "port": 8747, "addresses": ["192.168.2.116"] }
}
```

- `403 {"error":"pairing/invalid-code"}`：配对码错误（同一 IP 连续 5 次失败后锁定 5 分钟）。
- `429 {"error":"pairing/rate-limited"}`：锁定期间（带 `retry-after` 秒数响应头）。

配对码可在桌面配对页手动更换（更换后旧码立即失效；已配对设备不受影响）。

## 3. REST

### 3.1 GET /v1/info

要求认证。返回当前设备与主机信息（同配对响应的 `plugin/host/server/device` 字段，`device` 为 `{id, name}`）。可用作连接健康检查。

### 3.2 POST /v1/rpc

要求认证。调用一个 Host Remote 端点（与桌面 Web GUI 同一 API 面）：

```json
{ "endpoint": "session/list", "args": { "_request": {} } }
```

响应恒为 RemoteResult 信封，**HTTP 状态码始终为 200**（业务失败在信封内）：

```json
{ "ok": true,  "value": { ... } }
{ "ok": false, "error": { "code": "gateway/arguments-invalid", "message": "...", "details": {} } }
```

端点白名单默认为 `session/*` 与 `$events/*`；白名单外的端点返回 `403 {"error":"remote/endpoint-forbidden"}`。

### 3.3 常用端点与已验证的参数形状

Host 对参数做严格校验，错误信息会精确指出缺失/多余字段（`gateway/arguments-invalid`），App 可据此自适应。

| 端点 | args | 说明 |
|---|---|---|
| `session/list` | `{"_request": {}}` | 会话列表（含运行状态、标题、cwd、token 用量等投影） |
| `session/page` | `{"request": {"sessionId": "..."}}` | 翻页读取会话事件 |
| `session/follow` | `{"request": {"address": {"kind": "session", "sessionId": "..."}}}` | （流）实时跟随会话 |
| `session/prompt` | `{"request": {"sessionId": "...", "requestId": "<幂等id>", "content": [{"type": "text", "text": "你好"}]}}` | 发送消息 |
| `session/cancel` | `{"request": {"sessionId": "..."}}` | 取消当前运行 |
| `$events` | （流，payload 必须为 `{"args": {}}`） | 订阅转发的主机事件（含审批） |
| `$events/result` | `{"clientId": "...", "eventId": "...", "outcome": {"kind": "result", "value": "allowed-once"}}` | 应答 waterfall 事件（审批/提问） |

`session/prompt.requestId` 是幂等键：同一 id 重复提交会被安全忽略（返回 `{accepted: true}`）。

## 4. WebSocket /v1/ws

Upgrade 请求带 `Authorization: Bearer <token>`，未认证直接被拒（无应答帧）。

### 4.1 帧类型（与桌面 `/api/remote.mux` 同构）

连接建立后服务端先发：

```json
{ "type": "hello", "plugin": {...}, "host": {...}, "server": {...}, "device": {...} }
```

之后三种帧并存：

**客户端 → 服务端**（与官方 stream-protocol 完全一致）：

```json
{ "type": "open",   "streamId": "s1", "endpoint": "session/follow", "payload": { "args": { ... } } }
{ "type": "item",   "streamId": "s1", "value": ... }        // 可选 value；uplink 上行
{ "type": "end",    "streamId": "s1" }                       // uplink 半关闭
{ "type": "cancel", "streamId": "s1" }                       // 取消该逻辑流
```

**服务端 → 客户端**：

```json
{ "type": "item",  "streamId": "s1", "value": ... }          // 下行数据（value 可省略表示 undefined）
{ "type": "end",   "streamId": "s1" }                        // 流正常结束
{ "type": "error", "streamId": "s1", "error": { "code": "...", "message": "...", "details": {} } }
{ "type": "notify", "event": "api-session/added", "payload": ... }   // 本插件扩展：主机事件推送
```

`streamId` 由客户端生成（每个逻辑流唯一）。服务端 30 秒 Ping 一次，客户端按 WebSocket 协议层自动 Pong 即可。

### 4.2 notify 事件（会话列表驱动）

| event | payload |
|---|---|
| `api-session/added` | SessionSummary（含 sessionId、标题等） |
| `api-session/removed` | `{sessionId}` |
| `api-session/status` | `{sessionId, running}` |
| `api-session/activity` | `{sessionId, updatedAt}` |

### 4.3 会话实时内容

`open session/follow` 后：

1. 首帧 `item` 是完整快照：`{type:"snapshot", header:{...}, ...}`
2. 之后是增量 `{type:"event", event:{...}}` 帧（消息、工具调用、助手流片段等）
3. 断线重连后重新 open 同一 `session/follow`，以最新快照恢复（`session/follow` 的请求可带游标参数收敛重复量）

### 4.4 审批与用户提问（waterfall 事件）

1. `open` 端点 `$events`（payload 必须精确为 `{"args": {}}`）
2. 首帧 `item`：`{type:"ready", clientId, host:{...}}` —— **保存 `clientId`**
3. 之后每个事件一个 `item`。`approval/request` / `user-questions/request` 的 payload 携带待应答请求及其 `eventId`
4. App 弹出审批卡；用户决定后调用 REST：

```json
POST /v1/rpc
{ "endpoint": "$events/result",
  "args": { "clientId": "<ready 帧的 clientId>", "eventId": "<事件的 eventId>",
            "outcome": { "kind": "result", "value": "allowed-once" } } }
```

   - 审批结果：`"allowed-once"` / `"rejected"`（也可 `"next"` 交给下一个应答者）
   - 用户提问：`{ "kind": "result", "value": { "questions": [ ... 答案 ] } }`（结构见事件 payload 内的 schema）
5. 先于手机作答的桌面端会赢（waterfall 先答先得）；App 收到后续事件自然对齐。

## 5. 重连语义

- 网络闪断：App 以指数退避（0.5s → 10s 封顶，带抖动）重连 WS；REST 直接重试。
- `$events` 流断开即作废（`clientId` 失效），重连后重新 open 获取新 `clientId`。
- 令牌被吊销：WS 升级被拒、REST 返回 401，App 应引导重新配对。

## 6. 错误码总表

| code | 层 | 含义 |
|---|---|---|
| `auth/required` | 本插件 | 缺少/无效 Bearer 令牌 |
| `pairing/invalid-code` | 本插件 | 配对码错误 |
| `pairing/rate-limited` | 本插件 | 配对尝试锁定中 |
| `pairing/bad-request` / `rpc/bad-request` / `admin/bad-request` | 本插件 | 请求体不合法 |
| `remote/endpoint-forbidden` | 本插件 | 端点不在白名单 |
| `gateway/arguments-invalid` | 网关 | 参数名/结构不匹配（含精确差异） |
| `gateway/input-invalid` | 网关 | 参数值未通过边界校验 |
| `gateway/signature-invalid` | 网关 | 用流端点调一元（或反之） |
| `gateway/cancelled` | 网关 | 调用被取消 |
| `gateway/service-unavailable` | 网关 | 目标服务未就绪 |
| 其余 `gateway/*`、`session/*` | 业务 | 语义见 message/details |
