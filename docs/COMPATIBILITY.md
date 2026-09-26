# 正式版本兼容矩阵

更新：2026-09-26。尚无发布组合完成 iOS 实机到主机的端到端验收；下列 macOS 行仅记录插件 carrier 的隔离 Host 验证。

| iOS | 插件 | 官方 DSH / Remote | contract ID | macOS | Windows | Linux | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 iOS app（iOS 26.0 Simulator，未连接） | `dsh-remote 1.0.0-m1.0` working tree，经隔离 profile 动态加载 | 0.1.7-rc.2 本机安装版 | `dshr-v1-dsh-0.1.7-rc.2-2026-09-26` | 部分通过 | 未测试 | 未测试 | 正式插件 carrier 实测配对/info/Bearer、secrets-redacted `settings/describe`、workspace/session、`workspace/follow` baseline + rename upsert + 新物理连接重新订阅基线、`readBytes` multipart、raw upload、双 `$events` stream ready/单流取消，以及当前 client generation 的 `$events/result` unary RPC；畸形结构被插件拒绝、旧 clientId 被真实 Gateway 拒绝。无真实 pending waterfall/审批问答闭环，也无 iOS 联通、默认设置生效范围 |

当前本地证据：两个仓库的 `contract-v1.json` 与所有 JSON fixtures 一致；插件 `pnpm test` 的 32 项测试（含 TypeScript build）在 DSH Electron 主进程 Node 24.18.1 下通过。`test/run-m0-host-probe.sh` 将正式插件加载到独立 DSH_HOME，实际经过官方 shared FetchHandler/Gateway，验证 pairing/info/Bearer、secrets-redacted `settings/describe`、workspace/session、`workspace/follow` 重连基线、`readBytes` multipart byte `00 7f 80 ff`、raw upload、双 `$events` 逻辑流 ready/单流取消隔离，以及 `$events/result` 当前代次 RPC 到达、畸形请求在 carrier 被拒、旧 clientId 由真实 Gateway 拒绝；这不制造真实 approval/question pending event。Host 设置的 current/stale revision CAS 由 probe-only loopback route 直连同一官方 shared FetchHandler，未通过正式 carrier 开放。Swift 的 pair/info、event-result、settings/workspace 官方 fixtures 同步验证；这些都不是 iOS→Host 联通证据。`primary-runtime/runtime.json` 另标 Node 24.21.0，但用途未确认，不用于 Host runtime 兼容声明。仍未验证默认设置对现有/后续会话的实际影响、production settings 写策略、真实审批/提问 waterfall 及取消/重连重放、上传取消/读回、TLS proxy、负载与背压、LiveContainer、Windows/Linux。正式组合发布前仍须记录双仓 SHA、IPA/npm 包摘要、Xcode/iOS/LiveContainer 版本和三平台实际 Host 环境；工作树版本不代表已发布。

记录必须覆盖：配对与撤销、workspace/session CRUD、history/live、模型/权限、approval/question、files/attachment、重连及插件退出。源码推断、stub 通过和真实 Gateway/真机通过分别标记。

当前电脑上安装的实验插件 0.1.11 不属于正式组合，也未在本轮被卸载或替换。旧实验端点不承担正式产品兼容义务。

本轮增补（2026-09-26）：隔离实际 Host probe 新增 `$events/result` current-generation RPC、malformed-payload deny 与 stale-clientId Gateway rejection；共享 access metadata 明列 `gatewayInternalUnary`，iOS 和插件 fixtures 同步。插件 `pnpm test` 32 项、移动根 Swift Package 29 项、`DSHMobileUI` 11 项通过。此前的 `workspace/follow` 重连基线与 official `settings/describe` schema/CAS 证据继续有效；设置写仍关闭。仍无真实待决审批/提问闭环、LiveContainer/iOS 联通或 Windows/Linux 支持；本轮证据只代表 macOS。

同一切片的移动端验证：Swift 根 Package 29 项、DSHMobileUI 11 项通过；Xcode Beta 27.0 本轮 iOS Simulator App target build 未通过。默认构建拒绝 pinned SwiftPM 宏插件（“must be enabled before it can be used”）；使用 `-skipMacroValidation` 后宏插件返回 malformed response，因此没有当前 checkout 的 App target build 成功证据。本轮 metadata 新字段由 Swift contract 测试解码验证；仍无 iOS→Host/LiveContainer 联通证据，这里不升级 Host 兼容状态。
