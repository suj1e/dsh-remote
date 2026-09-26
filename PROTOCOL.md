# dsh-remote 正式接入契约 v1

更新：2026-09-26。状态：1.0.0 目标设计，M0 完成实际 carrier 校准后冻结。当前仓库尚无正式服务实现，不能把示例当成在线接口已可用的声明。

本文拥有设备接入契约；session、workspace、文件、审批等业务契约由固定版本官方 DSH Remote 拥有。[iOS 消费面与源码证据](../dsh-mobile/docs/PROTOCOL-BASELINE-1.0.0.md)记录所需业务接口，[插件计划](docs/PLAN-1.0.0.md)记录实现顺序，[兼容矩阵](docs/COMPATIBILITY.md)记录通过验证的组合。

## 1. 契约分层

| 层 | 所有者 | 变化规则 |
| --- | --- | --- |
| 配对、手机鉴权、主机身份、访问能力元数据 | dsh-remote | 在正式 accessVersion 下向后兼容；破坏性改变升 major |
| RPC 参数、RemoteResult、流 frame/byte codec、session/event 语义 | 官方 DSH | 按确切 DSH/package 版本固定，插件不改字段、不重建业务对象 |
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
| POST /v1/rpc | Bearer + endpoint allowlist | endpoint 与 args 原样交官方 dispatchRpc，保留官方参数验证与 RemoteResult |
| WS /v1/ws | Upgrade Bearer + 每个逻辑流 allowlist | 复用官方 stream-protocol 的 open/item/end/cancel/error 与字节载体 |
| 官方附件上传 / 字节载体的认证映射 | Bearer + 对应会话及 endpoint 权限 | M0 固定路径、content-type 和 framing；直接复用官方上传/字节 codec，不定义手机文件业务协议 |
| 主机管理入口 | 主机操作方权限 | 通过官方 Host 设置入口；如需独立 HTTP 管理路由，限定回环、准确 origin 和管理鉴权，手机 token 不能访问 |

RPC 外层只有选端点和传参的职责，例如：

    {"endpoint":"session/list","args":{"_request":{}}}

流传参保留官方 payload 外层，例如：

    {"type":"open","streamId":"events","endpoint":"$events","payload":{"args":{}}}

业务返回仍是官方 RemoteResult。HTTP 认证/限流/体积错误可先返回对应 HTTP 错误；已进入 Gateway 的业务失败保留官方 code/message/details，不能把所有 HTTP 错误描述成 200。

字节载体是 M0 发布阻断项：官方 Uint8Array/attachment framing 必须能双向无损承载并可取消。确定具体 carrier 前，transports 不能声明 bytes/upload 可用；不得用 JSON.stringify(Uint8Array) 或将文件全读成大字符串绕过此门禁。

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
