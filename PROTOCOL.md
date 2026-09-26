# dsh-remote 正式接入契约 v1

更新：2026-09-26。状态：M0 已按本机 DSH 0.1.7-rc.2 安装包核对官方 HTTP/stream/bytes carrier 源码，插件 wire-shape fixtures 通过 Node 测试；真实 Host round-trip 与 WebSocket adapter 仍待 M0 验证。当前仓库尚无正式服务实现，不能把示例当成在线接口已可用的声明。

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

POST /v1/pair 的输入是配对码和手机名称；返回独立 deviceId、deviceToken 和主机元数据。token 由 Node crypto 生成至少 32 字节随机值，服务端持久化摘要，手机持久化到 Keychain。每个主机独立签发，令牌不能跨主机转用。

GET /v1/info 在设备认证后返回下列元数据。字段是本版设计，M0 以两端 fixture 固定最终 JSON schema：

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
- `dsh-client-file-upload` 的 Host Fetch route 是 `POST /api/session/uploadFileBinary`，接受 `application/octet-stream`，以 `sessionId`（和可选 `name`）寻址，request body mode 为 streaming，并把 `Request.signal` 传给上传服务。必须通过官方 FetchHandler 路由，不转成字符串/JSON；真实 Host round-trip、取消与限额仍列为 M0 未完成项。
- Gateway `stream-protocol` 使用 JSON text messages，mux path 是 `/api/remote.mux`；字节流不走 mux。App/插件只做设备认证、精确 allowlist 和 carrier adaptation。

以上是本机安装包源码/README 确认，不等于 Fastify → shared FetchHandler → 实际 DSH Host 的端到端成功。兼容识别值和带状态 fixtures 见两个仓库同内容的 `contract/` 与 `test/fixtures/contract-v1/`。在 Host round-trip 通过之前，`/api` 的产品端到端兼容与附件能力仍不得标记通过。

HTTP(S) baseURL 可含受支持代理前缀。由 URL 解析器拼接路径和切换 ws/wss，不能字符串硬拼。TLS 可在反向代理终止；传入代理头仅在显式配置可信代理时接受。客户端不忽略 TLS 错误，不向跨源 redirect 转交 token。

## 4. Endpoint 暴露策略

默认策略由产品需要的具体官方方法组成，不使用全局 *：

- session：list/create/fork/rename/search/follow/page/control/projections/prompt/cancel/updateQueue/modelCatalog/selectModel/attachment。
- workspace：follow/create/rename/delete/insertBefore、归档/恢复/置顶/排序相关已验证方法。
- directoryPicker/list：供远程选择已有目录。
- workspaceFiles：list/read/stat/readBytes/changes。
- fileUploads：官方上传所需方法/route。
- agentPresets：list/read/select；permissionPresets/catalog。
- commands/execute：用于官方当前会话权限设置，入口沿用官方命令授权；不能在插件重新实现 /permission。
- settings：只暴露产品默认配置所需的 describe/update 操作，限制可写 namespace/字段。
- 精确 $events 与 $events/result。

名单中的方法必须在固定官方包实际存在并通过样本校准才启用。credentials、任意插件安装、账号管理、磁盘写入/删除和未列方法不会因 namespace 相似而获准。

鉴权与允许列表必须同时覆盖 unary、stream 和原始文件 body，不能让 bytes route 成为旁路。过滤 settings 字段是接入权限限制；官方 revision/schema/业务校验仍交 Gateway。

## 5. 流、恢复与资源所有权

每个物理连接拥有逻辑 stream 注册表；streamId 只在该连接内唯一。终止、设备撤销、插件关闭都传递 AbortSignal，释放 Gateway 订阅、文件传输和监听器。慢消费者按已配置预算背压或明确断开，不能无限缓冲。

保留官方缺失 item.value 与 JSON null 的区别。普通主机事件不是可靠队列，不提供全量通知重放承诺。workspace/control/follow 的 baseline/query/cursor 负责恢复。

$events ready 的 clientId 属于该代连接，重连必须获取新值。只对仍有效的 pending waterfall 作答；取消、已处理和旧代次不能复活。官方源负责是否可重放未决请求，插件不能私存一套“待审批真相”。

会话发送使用官方 requestId 幂等。读请求可按策略重试；不能把所有写请求在断线后无差别重发。桌面与手机结果竞争，以官方结果与取消/完成通知收敛。

多主机聚合由 iOS 负责。插件只代表其所在 Host，所有 token、会话、文件和交互操作按该 Host 授权，不代理其它主机。

## 6. 冻结与变更

M0 将本设计补成可执行契约：确定完整元数据 JSON schema、官方 carrier/framing、限额数值、精确方法参数、取消/错误样本、成对 contract ID。既不能在未验证时称“已支持”，也不能把未解决的文件/提问问题降为正式版已知限制。

每个正式变更同时更新本文件、共享 fixtures、iOS 对应 DTO 和兼容矩阵。只添加新 metadata 字段应允许旧正式客户端忽略；官方业务破坏性变更按新的 DSH 兼容组合发布。
