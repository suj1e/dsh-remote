# 正式版本兼容矩阵

更新：2026-09-26。尚无发布组合完成 iOS 实机到主机的端到端验收；下列 macOS 行仅记录插件 carrier 的隔离 Host 验证。

| iOS | 插件 | 官方 DSH / Remote | contract ID | macOS | Windows | Linux | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 iOS app（iOS 26.0 Simulator，未连接） | `dsh-remote 1.0.0-m1.0` working tree，经隔离 profile 动态加载 | 0.1.7-rc.2 本机安装版 | `dshr-v1-dsh-0.1.7-rc.2-2026-09-26` | 部分通过 | 未测试 | 未测试 | 正式插件 carrier 实测配对/info/Bearer、settings describe、workspace/session、follow 基线/增量/重连、multipart readBytes、raw upload 和 `$events/result`。隔离真实 Host 经官方 user-question/approval 服务验证 answer、delivery-local next、sibling cancel、Host abort、未决 question 同 eventId 换代重放；approval 由 probe-opened turn 直接调用，未验证 LLM/tool 触发 Agent loop。无 iOS 联通、默认设置生效范围 |

当前本地证据：两个仓库的 `contract-v1.json` 与所有 JSON fixtures 一致；插件 `pnpm test` 的 33 项测试（含 TypeScript build）在 DSH Electron 主进程 Node 24.18.1 下通过。`test/run-m0-host-probe.sh` 将正式插件加载到独立 DSH_HOME，经过生产 listener 与官方 FetchHandler/Gateway，验证 pairing/info/Bearer、secrets-redacted settings describe、workspace/session/follow、readBytes multipart byte `00 7f 80 ff`、raw upload、`$events/result` 代次校验，以及两条官方服务级 waterfall：`userQuestions.ask` 和探针开启 turn 后直接调用的 `approval.request`。探针验证 `next` 局部撤回、首个终态答复取消 sibling、Host question abort、未决 question 同 eventId 在新 clientId 下重放；这不是 LLM/tool 触发的真实 Agent loop。Host 设置的 current/stale revision CAS 由 probe-only route 直连同一官方 shared FetchHandler，正式 carrier 仍关闭 settings 写入。Swift fixture tests 同步覆盖 waterfall、event-result、settings/workspace 样本；没有 iOS→Host 联通证据。`primary-runtime/runtime.json` 另标 Node 24.21.0，但用途未确认，不用于 Host runtime 兼容声明。仍未验证默认设置对现有/后续会话的实际影响、production settings 写策略、LLM/tool 触发的真实审批/提问闭环、上传取消/读回、TLS proxy、负载与背压、LiveContainer、Windows/Linux。正式组合发布前仍须记录双仓 SHA、IPA/npm 包摘要、Xcode/iOS/LiveContainer 版本和三平台实际 Host 环境；工作树版本不代表已发布。

记录必须覆盖：配对与撤销、workspace/session CRUD、history/live、模型/权限、approval/question、files/attachment、重连及插件退出。源码推断、stub 通过和真实 Gateway/真机通过分别标记。

当前电脑上安装的实验插件 0.1.11 不属于正式组合，也未在本轮被卸载或替换。旧实验端点不承担正式产品兼容义务。

本轮增补（2026-09-26）：隔离实际 Host probe 新增真实官方服务 waterfall answer、`next`/终态竞争、abort 与 question 重连重放，以及规范化 waterfall fixtures；旧代次与畸形 event result 仍由 Gateway/carrier 正确拒绝。共享 access metadata 明列 `gatewayInternalUnary`。插件 `pnpm test` 33 项、移动根 Swift Package 30 项、`DSHMobileUI` 11 项通过。approval 测试 turn 由 probe 打开，不代表 LLM/tool 发起链；无 LiveContainer/iOS 联通或 Windows/Linux 支持，本轮仅有 macOS Host 证据。

同一切片的移动端验证：Swift 根 Package 29 项、DSHMobileUI 11 项通过；Xcode Beta 27.0 本轮 iOS Simulator App target build 未通过。默认构建拒绝 pinned SwiftPM 宏插件（“must be enabled before it can be used”）；使用 `-skipMacroValidation` 后宏插件返回 malformed response，因此没有当前 checkout 的 App target build 成功证据。本轮 metadata 新字段由 Swift contract 测试解码验证；仍无 iOS→Host/LiveContainer 联通证据，这里不升级 Host 兼容状态。
