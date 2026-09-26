# dsh-remote 1.0.0 正式产品与实施规划

更新：2026-09-26。与 [DSH Mobile 产品规格](../../dsh-mobile/docs/PLAN-1.0.0.md)及[联合里程碑](../../dsh-mobile/docs/IMPLEMENTATION-1.0.0.md)共同实施。

两个仓库均从零建设；实验源码已移出工作区，Git 历史保留。原 0.1.11 包只作为探测证据，不承担兼容义务。正式首发目标为 dsh-mobile 1.0.0 + dsh-remote 1.0.0，后续各自版本化，并通过兼容矩阵配套发布。

## 1. 插件的产品职责

插件安装在每台运行 DSH 的主机上，同一包支持 macOS、Windows、Linux 的相应 DSH Host。它提供手机配对、设备鉴权、稳定实例身份、能力信息和官方 Remote 的网络接入。

会话创建、日志、实时回复、工作区、文件授权、模型设置、审批与提问继续由官方 DSH 所有者处理。插件不生成另一套移动会话、轨迹或审批状态，也不建立推送服务。

| 插件功能 ID | 必做内容 | 用户可见结果 |
| --- | --- | --- |
| G1 | 官方 Host 生命周期与跨平台加载 | 安装/启停/重启/卸载不残留端口、监听者或任务 |
| G2 | 配对窗口、二维码、设备名称、独立 token、撤销 | 一部手机可分别配多主机；任一 token 撤销会关闭其连接 |
| G3 | 稳定 instanceId、版本、能力清单、连接地址 | iOS 能区分主机和手机 ID；改地址不变成另一台主机 |
| G4 | 官方 unary/stream/bytes carrier | iOS 可消费同一 Gateway 业务定义及错误，流式数据和二进制不失真 |
| G5 | 工作区、会话与配置访问范围 | 首发功能涉及的确切 endpoint 可达；未授予的能力明确拒绝 |
| G6 | 官方审批/问题事件与结果 | 连接代次与取消遵循 Gateway，桌面和手机处理后能一致收敛 |
| G7 | 文件读取、附件接收、取消与传输限额 | 字节无损、有限内存、下载中变更可发现；不绕过官方文件权限 |
| G8 | 主机端设置与设备管理 | 通过 DSH 官方设置入口启停、查看地址/版本、开启配对、撤销设备 |
| G9 | 诊断与发布 | 三 OS 安装记录、脱敏日志、成对版本矩阵、可重复 npm 包 |

## 2. 成熟技术选型

| 能力 | 固定选择 | 责任边界 |
| --- | --- | --- |
| 运行时 | Node.js 24 开发/CI；TypeScript strict、ESM | 运行在官方支持的 Host 环境；M0 核对实际桌面内嵌 runtime，不能仅看开发机 node 版本 |
| 插件框架 | 官方 @deepseek-ai/cordis、DSH 插件生命周期、home-paths 与配置机制 | 官方 peers 锁定同一 DSH build；资源由插件 effect/dispose 管理 |
| Remote / HTTP carrier | 官方 dsh-api-gateway、dsh-typert-protocol、dsh-client-connection | 设备认证后调用 `connection.createSharedFetchHandler('/api')`；复用官方 endpoint dispatch、request/response envelope、multipart bytes、精确 Fetch routes；不复制 Gateway 或 Connection |
| 外部 HTTP listener | [Fastify 5.x](https://github.com/fastify/fastify/tree/5.x) | routing、配对/设备认证 hooks、请求限额、生命周期与脱敏日志；只做 Node ↔ Web `Request/Response` 薄适配，不创建另一套 RPC protocol |
| WebSocket | [@fastify/websocket](https://github.com/fastify/fastify-websocket) 的 Fastify 5 兼容正式版本，底层 ws | 承载官方 `/api/remote.mux` path；使用 `@deepseek-ai/dsh-api-gateway/stream-protocol` 与 Host `wireStream` adapter。精确并发/取消/关闭语义须经 M0 Host 验证，不复制 session/event 业务逻辑 |
| 限流 | [@fastify/rate-limit](https://github.com/fastify/fastify-rate-limit) 的 Fastify 5 兼容版本 | 配对尝试、并发请求配额；不自写滑动窗口算法 |
| CORS | @fastify/cors 的 Fastify 5 兼容版本，限主机管理 UI 所需 origin | 普通手机请求无需 CORS；不能使用任意 origin 或以 CORS 代替鉴权 |
| 配对二维码 | qrcode 1.5.x | 只编码地址与临时配对信息，不含长期 token |
| 随机值/凭据摘要 | Node crypto 的 randomBytes、randomUUID、createHash、timingSafeEqual | 随机 token 和稳定实例 UUID；不自造加密协议/JWT 服务 |
| Registry 持久化 | JSON + [write-file-atomic](https://github.com/npm/write-file-atomic) | 少量 instance/device 数据；标准原子写，失败不重置 registry；不重建数据库框架 |
| 主机端 UI | DSH 提供的设置 slots、configForms 与 React/UI 组件 | 使用 Host 对应版本，不捆另一份 React 或另建独立 Web 管理应用 |
| 构建 | pnpm 锁文件、TypeScript、tsdown，遵循官方插件打包约定 | peers external，Host/client 两个入口分别构建；插件包只含运行所需文件 |
| 测试/诊断 | Node test runner、Fastify inject、真实官方 Gateway 集成、Fastify/Pino redact + DSH logger | stub 只测 adapter；正式兼容要求真实 Host。Windows/Linux/macOS CI 同一套用例 |

先锁定上述组件和版本系列；M0/M1 解析时选该系列的正式 patch 版本并写入 package.json 与 pnpm-lock.yaml。Fastify 官方主分支已面向 v6，本项目明确选成熟 5.x 线，并按插件兼容表锁版本，禁止直接安装浮动 latest。TypeScript/tsdown 与官方插件构建工具链一致后固定精确版本。

不额外建设账号、Redis、SQL 服务或云端控制面。设备 registry 是单主机本地状态；没有多用户服务端协作需求。

## 3. 模块与状态

    src/
      host/index.ts            Cordis 安装、配置、资源释放
      config.ts                官方配置 schema
      access/
        registry.ts            instanceId、设备摘要、schema 版本
        pairing.ts             配对窗口与 token 签发
        authorization.ts       设备认证、能力访问策略
      server/
        app.ts                 Fastify listener 与插件注册
        pairing-routes.ts      仅配对与身份元数据
        remote-carrier.ts      官方 RPC/stream/bytes carrier 薄适配
        lifecycle.ts           连接集合、撤销、取消、限额
      client/
        index.tsx              DSH 设置入口
        pairing-panel.tsx      地址、QR、设备管理
      diagnostics.ts           脱敏错误与版本信息
    test/
      fixtures/                与 iOS 相同 contract ID 的协议样本
      integration/             实际 Gateway 与生命周期
    docs/
      PLAN-1.0.0.md
      COMPATIBILITY.md

registry 的正式 schema v1 保存：随机 hostInstanceId、schemaVersion、设备 ID/名称/tokenHash/创建时间/撤销状态；配对窗口有有效期。启动时持久化读失败必须明确错误，不能生成新 host ID 伪装正常。正式版本升级保持 host ID 与已配对设备；实验数据重新配对。

插件不能保存 prompt、完整会话日志、主机 Provider 密钥或 iPhone Keychain 内容。原始正文和文件仅按请求有界转发，不作为副本持久化。

## 4. 接入与权限原则

- 默认通过可信网络访问；公网接入在外部反向代理终止 HTTPS。原生 Host listener 的 HTTP 与外部 advertised HTTPS 地址分开配置。
- 管理入口只允许主机操作方访问；配对 token 不具有管理其它手机、安装插件或读取凭据的权限。
- 配对是显式开启的短期窗口；限制失败次数/速率，成功返回独立随机 token，服务端只存摘要。配对窗口关闭不撤销已配设备。
- revoke 立即使 HTTP 认证失败、关闭该设备 socket、取消相关上传/订阅；不能影响其它设备。
- 所需 endpoint 列表来自官方描述符和产品映射。裸 $events 必须支持精确匹配；不存在的端点/多余路径段不能被通配误放行。
- abilities 元数据代表当前实际可访问的安装能力，不能把整个 DSH 支持目录当成已启用能力。官方没有通用动态发现服务时，使用本插件固定、已验证的 capability manifest 与已挂载服务检查。
- 连接、stream 数、frame 大小、上传字节、in-flight 请求、idle/请求超时都必须有显式限额；数值在 M0 的官方上限/负载样本上确定并写入配置，不能无限缓冲。
- 请求断开传播 AbortSignal。字节处理使用官方 carrier 与 Node streams/pipeline backpressure；不能将任意大文件先完整读入字符串。
- 日志由成熟 logger 的 redact 管理，Bearer、配对码、正文、问题答案与文件内容不出现在常规日志。

## 5. 联合里程碑

| 阶段 | dsh-remote 交付 | 与 iOS 的交接条件 |
| --- | --- | --- |
| M0 | 官方 Endpoint/Bytes/Event feasibility；共享样本；接入元数据 schema 定稿 | iOS 解析相同样本；业务字段无另一套自定义映射 |
| M1 | 新插件工程、Fastify、官方 Connection/Gateway peers、registry、官方生命周期、Host 设置骨架、三 OS CI | listener 启停可控，官方 shared FetchHandler 可从独立 listener 调用，包可安装，instanceId 重启稳定 |
| M2 | 配对/撤销/info、RPC/WS、工作区/会话/目录白名单与实际验证 | 三主机配对并行；工作区和会话操作经官方 Gateway |
| M3 | follow/page/control、模型/默认配置、附件上传 carrier | 同一 requestId 重试、模型权限生效、上传可取消且归属正确 |
| M4 | $events、审批/问题结果、pending 重放/代次取消 | 桌面/手机竞态与失效请求的联合验收 |
| M5 | workspaceFiles/readBytes/changes、下载载体及资源预算 | 文本/二进制/变化文件、路径与授权三 OS 一致 |
| M6 | 三 OS 安装/升级/卸载、并发/故障测试、包体与许可证、版本矩阵 | npm 包与 IPA 的 commit SHA 和版本共同固定后发布 |

M0 的契约验证使用独立临时 workspace/session，不操作用户真实任务。建立双仓库 issue/任务编号关联，每项写明插件端与 iOS 端 owner（角色，不虚构人员）。

### 当前实施检查点（2026-09-26）

- 接入面：生产 Cordis effect 已持有 registry 与 listener 生命周期；Fastify 实现 `/v1/pair`、`/v1/info`、Bearer 设备认证、官方 shared FetchHandler unary/streaming upload，以及基于官方 Remote mux parser + Gateway `wireStream` 的 WebSocket carrier。默认拒绝 endpoint policy 与实时 permission catalog 检查保留。
- 验证：`pnpm test` 在 DSH Electron Node 24.18.1 下 TypeScript build + 27 项测试通过。隔离 DSH profile 中加载正式插件后，实际 DSH 0.1.7-rc.2 Host 验证 pairing/info/Bearer、workspace/session、multipart `readBytes`、原始上传和两条 `$events` 逻辑流的 ready/单流取消隔离。
- 双端契约：`deviceAccess` schema 及 pair/info/Remote fixtures 已同步到 dsh-mobile，Swift DTO 测试通过。
- 未退出项：尚无 iOS→Host/LiveContainer 联通；approval/question waterfall uplink、上传取消和文件读回、TLS proxy/部署安全、负载背压、Windows/Linux、Host 设置 UI/配对二维码、发布 CI 仍未验证/实现。已通过的 macOS carrier 样例不代表三平台兼容或 M0 完成。

## 6. 兼容与发布

[COMPATIBILITY.md](COMPATIBILITY.md)是唯一成对验证记录。每条包含 iOS tag/SHA、插件 tag/SHA、DSH build 与官方 peer 版本、contract ID、OS 与测试状态；仅源码看过的行不能写“支持”。

正式版不兼容旧实验协议的义务由用户取消。`/v1/pair` 与 `/v1/info` 是插件自己的设备接入控制面；DSH 业务数据面保留官方 `/api/{namespace}/{method}`、`/api/remote.mux`、envelope 与 multipart/Fetch-route 语义。只有 M0 验证官方 handler 不能承载的边缘能力后，才能增加最小 transport adapter，不能创造第二份业务协议。

升级官方 DSH 时独立做兼容 PR，先变样本/contract ID，分别通过插件和 iOS 检查再更新支持矩阵。禁止只把 peerDependencies 改成 >= 某版本就宣称兼容。
