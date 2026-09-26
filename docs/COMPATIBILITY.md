# 正式版本兼容矩阵

更新：2026-09-26。尚无发布组合完成 iOS 实机到主机的端到端验收；下列 macOS 行仅记录插件 carrier 的隔离 Host 验证。

| iOS | 插件 | 官方 DSH / Remote | contract ID | macOS | Windows | Linux | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 iOS app（iOS 26.0 Simulator，未连接） | `dsh-remote 1.0.0-m1.0` working tree，经隔离 profile 动态加载 | 0.1.7-rc.2 本机安装版 | `dshr-v1-dsh-0.1.7-rc.2-2026-09-26` | 部分通过 | 未测试 | 未测试 | 正式插件 carrier 实测配对/info/Bearer、workspace/session、`workspace/follow` baseline + rename upsert + 新物理连接重新订阅基线、`readBytes` multipart、raw upload、真实 `$events` 双流 ready/单流取消隔离；没有 iOS 设备联通、网络恢复代次或审批/提问结果回传证据 |

当前本地证据：两个仓库的 `contract-v1.json` 与所有 JSON fixtures 一致；插件 `pnpm test` 的 28 项测试（含 TypeScript build）在 DSH Electron 主进程 Node 24.18.1 下通过。`test/run-m0-host-probe.sh` 将正式插件加载到独立 DSH_HOME，实际经过官方 shared FetchHandler/Gateway，验证 pairing/info/Bearer、workspace/session、`readBytes` multipart byte `00 7f 80 ff`、raw upload 和正式 carrier 的双 `$events` 逻辑流 ready/单流取消隔离。Swift 的 pair/info 解码和官方 Remote fixtures 同步验证；这些都不是 iOS→Host 联通证据。`primary-runtime/runtime.json` 另标 Node 24.21.0，但用途未确认，不用于 Host 兼容声明。仍未验证审批/提问事件 uplink waterfall、上传取消/读回、TLS proxy、负载与背压、LiveContainer、Windows/Linux。正式组合发布前仍须记录双仓 SHA、IPA/npm 包摘要、Xcode/iOS/LiveContainer 版本和三平台实际 Host 环境；工作树版本不代表已发布。

记录必须覆盖：配对与撤销、workspace/session CRUD、history/live、模型/权限、approval/question、files/attachment、重连及插件退出。源码推断、stub 通过和真实 Gateway/真机通过分别标记。

当前电脑上安装的实验插件 0.1.11 不属于正式组合，也未在本轮被卸载或替换。旧实验端点不承担正式产品兼容义务。

本轮增补（2026-09-26）：隔离实际 Host probe 已新增 `workspace/follow` baseline、触发 `workspace/rename` 后的 upsert，以及关闭物理连接后重新连接并取得最新完整 baseline 的验证；dsh-remote `pnpm test` 为 29 项通过。这里记录的生产 Host 通过项仍只代表 macOS carrier，不代表 LiveContainer/iOS 联通或 Windows/Linux 支持；iOS 网络断线代次与恢复仍未验证。

同一切片的移动端验证已完成：Swift Package 27 项、DSHMobileUI 11 项通过，Xcode Beta 27.0 iOS Simulator App target build 通过。仍无 iOS→Host/LiveContainer 联通证据；这里的 Host 兼容状态不因此升级。
