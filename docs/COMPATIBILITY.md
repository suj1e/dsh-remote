# 正式版本兼容矩阵

更新：2026-09-26。当前没有完成正式端到端验证的发布组合。

| iOS | 插件 | 官方 DSH / Remote | contract ID | macOS | Windows | Linux | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 iOS app（iOS 26.0 Simulator） | M1 插件骨架（`1.0.0-m1.0`，未发布；未安装） | 0.1.7-rc.2 候选基线 | `dshr-v1-dsh-0.1.7-rc.2-2026-09-26` | 未配对 | 待验证 | 待验证 | Xcode 27.0 app build 与 2 项 UI 冒烟通过；无 iOS→Host 联通证据 |
| test-only Fastify carrier probe（非产品插件） | 临时 DSH profile 动态加载 | 0.1.7-rc.2 本机安装版 | `dshr-v1-dsh-0.1.7-rc.2-2026-09-26` | 部分通过 | 未测试 | 未测试 | macOS 实际 Gateway：workspace/session、readBytes、raw upload；`$events` ready 与 in-process AbortSignal 取消通过；非 WS、非手机端到端 |

当前本地证据：两个仓库的 `contract-v1.json` 与 wire-shape fixtures 一致；插件在本机 DSH Electron 主进程 Node 24.18.1 + pnpm 11.9.0 下 `pnpm test` 17 项通过（含 TypeScript build），其中两项使用真实 Fastify 与官方 `HostConnectionService`，handler 为合成测试；另有 `test/run-m0-host-probe.sh` 在本机安装版 DSH 0.1.7-rc.2 的隔离 profile 中实际经过官方 shared FetchHandler/Gateway，验证 workspace/session、readBytes multipart byte `00 7f 80 ff`、raw streaming upload、`$events` ready 与 Gateway in-process stream AbortSignal 取消。安装包的 `primary-runtime/runtime.json` 另标注 Node 24.21.0，但用途与插件主进程关系未确认，不用于 Host runtime 兼容声明。Swift Package 测试 10 项通过；Xcode 27.0 在 iOS 26.0 Simulator 构建通过，2 项 XCUITest 冒烟通过。上述 Host probe 不验证生产插件生命周期、物理 WS mux、事件 waterfall、上传取消/限额、手机网络连接或跨平台；无 LiveContainer/IPA 证据。正式组合仍须记录两个仓库 SHA、包/IPA 摘要、Xcode/iOS/LiveContainer 版本和三平台实际 Host 环境；表中候选版本不代表已发布。

记录必须覆盖：配对与撤销、workspace/session CRUD、history/live、模型/权限、approval/question、files/attachment、重连及插件退出。源码推断、stub 通过和真实 Gateway/真机通过分别标记。

当前电脑上安装的实验插件 0.1.11 不属于正式组合，也未在本轮被卸载或替换。旧实验端点不承担正式产品兼容义务。
