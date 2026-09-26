# dsh-remote 正式接入契约 v1

更新：2026-09-26。状态：按本机 DSH 0.1.7-rc.2 安装包核对官方 HTTP/stream/bytes carrier；DSH Electron Node 24.18.1 下 `pnpm test`（TypeScript build + 33 tests）通过。正式插件在独立临时 DSH_HOME 中经生产 carrier/官方 Gateway 验证配对与鉴权、settings describe、workspace/session、workspace-follow 重连基线、readBytes multipart、raw upload，以及 `$events/result` 代次校验。隔离 Host 还经真实临时 Agent 的官方 `userQuestions.ask` 和 `approval.request` 服务验证 answer、`next`、首个终态结果取消 sibling、Host abort cancel 与未决 question 同 eventId 换代重放；approval 由探针在测试开启的 turn 中直接调用，不是 LLM/tool 生成。正式 carrier/Gateway 的这些 macOS 样本不证明 iOS、Windows/Linux、完整 Agent tool loop、默认设置生效范围、上传后读回、外部 HTTPS 代理或负载/背压。

本文拥有设备接入契约；session、workspace、文件、审批等业务契约由固定版本官方 DSH Remote 拥有。[iOS 消费面与源码证据](../dsh-mobile/docs/PROTOCOL-BASELINE-1.0.0.md)记录所需业务接口，[插件计划](docs/PLAN-1.0.0.md)记录实现顺序，[兼容矩阵](docs/COMPATIBILITY.md)记录通过验证的组合。

## 1. 契约分层

| 层 | 所有者 | 变化规则 |
| --- | --- | --- |
| 配对、手机鉴权、主机身份、访问能力元数据 | dsh-remote | 在正式 accessVersion 下向后兼容；破坏性改变升 major |
| RPC 参数、Connection 请求/响应、流 frame/byte codec、session/event 语义 | 官方 DSH | 按确切 DSH/package 版本固定，插件不改字段、不重建业务对象；外部设备鉴权在 carrier 之前完成 |
| 多主机路由、缓存、界面模型 | dsh-mobile | 本地 profile UUID + remote resource ID，不发明新 Host 业务实体 |

首次正式 v1 不兼容实验 v1 是明确的产品决定。实验 PROTOCOL.md 已归档，不作为新实现模板。

## 2. 配对与身份

配对由主机操作方开启有期限的窗口。二维码包含可达 baseURL、临时配对信息和接入版本；长期凭据只能在成功配对响应中返回。保留手工输入地址和配对码。

POST /v1/pair 的输入是配对码和手机名称；成功时返回设备 ID、仅此响应出现的 `deviceToken` 和主机元数据。POST/GET 的冻结 wire schema 与代表性样本位于双仓相同的 `deviceAccess` 与 `pair-*`/`info-*` fixtures。token 由 Node crypto 生成 32 字节随机值，服务端持久化 SHA-256 摘要，手机持久化到 Keychain。每个主机独立签发，令牌不能跨主机转用。

GET /v1/info 在设备认证后返回下列元数据和当前设备信息，不返回 token：

| 字段 | 语义 |
| --- | --- |
| accessVersion | 本插件配对/鉴权/载体版本，首次正式值 1 |
| contractId | 固定官方 Remote 版本与消费面 fixture 的标识；不是宣称官方存在这个版本字段 |
| plugin.name / version | 正式 npm 插件身份和版本 |
| dsh.version | 实际运行的官方 DSH build；不可硬编码为开发机版本 |
| host.instanceId | 安装实例持久随机 UUID，重启/改地址不变；清空正式 registry 才产生新身份 |
| host.name / platform | 显示名与 darwin/win32/linux；hostname 不作身份 |
| device.id / name | 这部配对手机的标识；不是主机 ID |
| endpoints | 当前允许且实际可用的官方 unary/stream endpoint 名称与类别 |
| transports / limits | 实际可用载体及请求、帧、连接、上传等预算；不得虚报 bytes 支持 |
| server.addresses | 候选访问地址；客户端不得自动把 token 发到广告地址 |

本地主机档案 ID 由 iOS 生成。instanceId 用于认证成功后的身份核对与用户确认的地址别名关联，不能代替认证。相同 instanceId 也不自动把不同 endpoint 合并或转移凭据。

配对失败区分无效/过期窗口、错误码、限流与服务未就绪。429 返回 Retry-After。撤销生效后新 HTTP 拒绝、现有该设备 WS/上传/订阅取消；其余设备不受影响。

## 3. 载体

| 入口 | 访问范围 | 处理规则 |
| --- | --- | --- |
| POST /v1/pair | 配对窗口 + 限流 | 插件自有设备接入操作 |
| GET /v1/info | Bearer | 只返回该设备可见的身份/版本/能力 |
| POST /api/{namespace}/{method} | Bearer + endpoint allowlist | 保留 DSH Connection 原生 HTTP 路径、`client-request` 信封及 `server-response`；鉴权后交给官方 `connection.createSharedFetchHandler('/api')` |
| WS /api/remote.mux | Upgrade Bearer + 每个逻辑流 allowlist | 复用官方 Remote mux 的文本 JSON frame；M0 继续确认本机 Gateway 的 in-process stream API 与关闭/取消边界 |
| 官方 Connection Fetch routes（含附件上传） | Bearer + 对应 route/会话权限 | 经同一个官方 shared FetchHandler；保留原始 body、请求取消及官方响应，不另造上传 endpoint |
| 主机管理入口 | 主机操作方权限 | 通过官方 Host 设置入口；如需独立 HTTP 管理路由，限定回环、准确 origin 和管理鉴权，手机 token 不能访问 |

设备数据面不再套 `/v1/rpc` 自定义 RPC 协议。除 `/v1/pair`、`/v1/info` 这类插件自有控制面外，手机按官方 Connection 形式请求 endpoint。示例请求路径与 JSON body：

    POST /api/session/list
    {"type":"client-request","rpcId":"rpc-001","method":"session/list",
     "payload":{"args":{"_request":{}}}}

成功或失败均保留官方响应 envelope：

    {"type":"server-response","rpcId":"rpc-001",
     "result":{"ok":true,"value":{}}}

流传参保留官方 path 与 payload 外层，例如：

    WS /api/remote.mux
    {"type":"open","streamId":"events","endpoint":"$events","payload":{"args":{}}}

HTTP 认证/限流/体积错误由接入层用 HTTP 状态表达；进入官方 Connection 后，Gateway 业务失败保留 `code/message/details`。禁止把错误文字转换成自定义业务结果。

### 3.1 官方 carrier 核对结果（DSH 0.1.7-rc.2）

- Gateway Host 提供 `ctx.typertGateway`；Connection Host 提供 `ctx.connection.createSharedFetchHandler('/api')`。后者分派 `/api` 下已注册的 Remote interceptor 与精确 Fetch route，并使用 DSH 自己的 JSON/附件响应编码。插件在 Fastify 外层先做手机 Bearer 鉴权和 endpoint allowlist，再将请求交给此 handler；不得自己调用业务 service、重建 `RemoteResult` 或 multipart serializer。
- 一元请求使用官方 `client-request` envelope：`type/rpcId/method/payload`；path 中的 method 必须与 body 一致。成功和业务失败都是 `server-response` envelope，失败字段为官方 `code/message/details`。
- 官方 Connection 的二进制响应为 `multipart/form-data`。`metadata` part 是带 `server-response` 的 JSON；顶层 `attachments` 项包含 result-value 相对 `path`、`codec:'bytes'`、part 名。原始 part 名为 `bytes-<index>`，接收端按 metadata 把 bytes 恢复到结果树；无附件与失败仍为 JSON。附件只用于 Remote 返回值，官方文档明确不支持二进制 stream/event。
- `dsh-client-file-upload` 的 Host Fetch route 是 `POST /api/session/uploadFileBinary`，接受 `application/octet-stream`，以 `sessionId`（和可选 `name`）寻址，request body mode 为 streaming，并把 `Request.signal` 传给上传服务。隔离实际 Host probe 已经通过正式插件 carrier 与官方 FetchHandler 发送原始字节并收到成功响应；取消传播、背压/负载资格和上传后业务读取仍列为 M0 未完成项。
- Gateway `stream-protocol` 使用 JSON text messages，mux path 是 `/api/remote.mux`；字节流不走 mux。公开 `TypertGatewayService.wireStream.open` 提供 Host in-process carrier。正式插件 adapter 使用 `@fastify/websocket` + 官方 `stream-protocol` parser + `wireStream` 做薄 socket bridge；隔离真实 Host 上已通过此生产 adapter 验证 `$events` service waterfall 的结果、delivery-local `next`、terminal cancel、question abort、question 同 eventId 换代重放，也验证 `workspace/follow` complete baseline、`workspace/rename` ordered upsert 与新物理连接的最新完整 baseline。审批请求使用实际 `ApprovalService`，但测试 turn 由探针打开；尚无模型/tool 生成事件的完整 Agent loop、iOS 网络断线代次与负载背压证据，不能宣称完整 Remote mux 兼容。

源码/README 结论与实际探测证据分开记录。`test/run-m0-host-probe.sh` 每次建立隔离 DSH_HOME，加载待验证的正式 `dsh-remote` dist 入口；另一个 test-only companion 插件只用于创建临时工作区、直连官方 API 作对照及报告测试端口/配对码。`test/m0-host-roundtrip.mjs` 经生产 listener、配对/Bearer、正式 shared FetchHandler/Gateway 验证 workspace/session、`workspace/follow` 完整基线与 rename upsert、新物理连接重新订阅后的最新完整基线、multipart `readBytes` 附件 `00 7f 80 ff` 还原、raw upload 和两条真实 `$events` 逻辑流 ready/单流取消隔离。它不触碰现有 DSH 用户 profile；临时 profile 成功后自动清理。该脚本仍不是 iOS 客户端网络恢复或三平台兼容证据。兼容识别值和带状态 fixtures 见两个仓库相同的 `contract/` 与 `test/fixtures/contract-v1/`。

HTTP(S) baseURL 可含受支持代理前缀。由 URL 解析器拼接路径和切换 ws/wss，不能字符串硬拼。TLS 可在反向代理终止；传入代理头仅在显式配置可信代理时接受。客户端不忽略 TLS 错误，不向跨源 redirect 转交 token。

## 4. Endpoint 暴露策略

唯一的计划 allowlist 是两仓库同 SHA-256 的 [`contract/contract-v1.json`](contract/contract-v1.json) 中 `endpointPolicy`。其成员来自本机 DSH 0.1.7-rc.2 的生成 `typert.remote-client.js`，按官方 descriptor 的 `mode` 分别列出 unary 与 streams；Fastify 和 WS 必须都采用默认拒绝，不得通过 namespace 通配。

边界约束：

- unary 覆盖产品所需的 session/workspace/file APIs、Agent preset、permission catalog 与 Gateway 内部 `$events/result`；stream 仅开放 `session/control`、`session/follow`、`workspace/follow`、`workspaceFiles/changes`、`$events`。上传同时要求官方 `fileUploads/upload` Remote 与精确 `POST /api/session/uploadFileBinary` Fetch route，保持原始流、会话归属和取消。
- 生成描述符中存在但本产品不暴露的 terminal、account、credentials、job、plugin manager、schedule、dynamic runner 等接口明确拒绝；未知 endpoint、额外路径段及未经声明的 Fetch route 均拒绝。
- `commands/execute` 虽在 endpoint allowlist 内，也只允许 `/permission`；preset 参数必须来自同一 Host 的 `permissionPresets/catalog`。不代理任意插件命令。
- `settings/describe` 是官方 secrets-redacted 读取。隔离 Host 实测的 `agent-default-model` schema 只有 `provider`、`model`、可选 `reasoningEffort`，`permission` schema 只有可选 `defaultPreset`；`applies` 为 `live`，每个 namespace 有独立 revision。官方 `settings/mutate` 参数是顶层 `ns`、`ops`、`expectedRevision`（官方 codec 允许省略 revision，但产品必须发送）；实际 Host 对过期 revision 返回 `settings/conflict`，details 含 `ns/expected/actual`，当前 revision 的已验证操作成功。该成功/冲突通过隔离测试插件中的 loopback route 直接调用官方 shared FetchHandler，不代表正式 dsh-remote 暴露写能力。正式插件仍默认拒绝 `settings/mutate`，直到实现并测试 exact namespace/path、model catalog/permission catalog 值约束和必填 CAS guard；不能因 schema fixture 已有就放开任意 `ops`。`settings/update`、`replace` 与 credentials API 永不开放。
- `$events` 源仅允许官方 `approval/request`、`user-questions/request` 两种 waterfall，普通 emit 事件不转发。`$events` mux 是下行流，官方 Gateway 会释放/忽略该流的 uplink；答复必须使用官方 unary `POST /api/$events/result`，body 仍为 Connection envelope，`payload.args` 是 `clientId/eventId/outcome`。正式插件对该 Gateway-internal endpoint 使用官方 `parseRemoteEventResult` 校验后才转交 shared FetchHandler；Host Gateway 要求 clientId 仍活跃，只对该客户端仍持有的 eventId delivery 采取动作。隔离真实 Host 已经由官方服务产生两个事件种类的 pending waterfall，并验证 `next` 仅撤回单个交付、终态答复取消另一活跃 delivery、Host question signal abort 下发 cancel、未决 question 在物理重连后用新 clientId/相同 eventId 重放；旧 clientId 与畸形结果也分别由 Gateway/插件拒绝。该 probe 直接调用官方服务（approval turn 由 probe 打开），尚未经过 LLM/tool 调用链。

鉴权与策略同时覆盖 unary、logical stream、`$events/result` 和原始文件 body，不能让 bytes route 或 WebSocket 逻辑流成为旁路。参数层 guard 只缩小设备权限；官方 schema、revision、授权和业务校验仍交 Gateway。

## 5. 流、恢复与资源所有权

每个物理连接拥有逻辑 stream 注册表；streamId 只在该连接内唯一。终止、设备撤销、插件关闭都传递 AbortSignal，释放 Gateway 订阅、文件传输和监听器。慢消费者按已配置预算背压或明确断开，不能无限缓冲。

保留官方缺失 item.value 与 JSON null 的区别。普通主机事件不是可靠队列，不提供全量通知重放承诺。workspace/control/follow 的 baseline/query/cursor 负责恢复。

$events ready 的 clientId 属于该代连接，重连必须获取新值。只对仍有效的 pending waterfall 作答；取消、已处理和旧代次不能复活。官方源负责是否可重放未决请求，插件不能私存一套“待审批真相”。

会话发送使用官方 requestId 幂等。读请求可按策略重试；不能把所有写请求在断线后无差别重发。桌面与手机结果竞争，以官方结果与取消/完成通知收敛。

多主机聚合由 iOS 负责。插件只代表其所在 Host，所有 token、会话、文件和交互操作按该 Host 授权，不代理其它主机。

## 6. 冻结与变更

设备接入元数据、限额、pair/info 与官方 waterfall 样本已写入双仓同一 contract/fixtures。M0 仍未退出：需继续固定剩余业务参数/错误样本、真实模型/tool 触发审批与提问、iOS 联通及重连代次、默认设置作用范围、production settings mutation guard、上传取消/读回、Windows/Linux、TLS/代理和负载背压。当前通过项只限 `hostRoundTripEvidence` 逐条列出的 macOS 真实 Host 能力；不能将整个 allowlist 或 M0 声称完成。

每个正式变更同时更新本文件、共享 fixtures、iOS 对应 DTO 和兼容矩阵。只添加新 metadata 字段应允许旧正式客户端忽略；官方业务破坏性变更按新的 DSH 兼容组合发布。
