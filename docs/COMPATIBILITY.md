# 正式版本兼容矩阵

更新：2026-09-26。当前没有完成正式端到端验证的发布组合。

| iOS | 插件 | 官方 DSH / Remote | contract ID | macOS | Windows | Linux | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 iOS app（iOS 26.0 Simulator） | M1 插件骨架（`1.0.0-m1.0`，未发布） | 0.1.7-rc.2 候选基线 | `dshr-v1-dsh-0.1.7-rc.2-2026-09-26` | 待验证 | 待验证 | 待验证 | Xcode 27.0 app build 与 2 项 UI 冒烟通过；真实 Host round-trip 未运行 |

当前本地证据：两个仓库的 `contract-v1.json` 与 wire-shape fixtures 一致；插件在 Node 24.21.0 下 `pnpm test` 15 项通过（含 TypeScript build）；Swift Package 测试 10 项通过；Xcode 27.0 在 iOS 26.0 Simulator 构建通过，2 项 XCUITest 冒烟通过。证据覆盖共享样本、endpoint policy、持久身份 schema、数据库 schema 与空状态 UI，不推出 HTTP adapter、WS mux、上传或任一 OS 已兼容。插件未安装到 DSH，listener 未启动；没有 LiveContainer、IPA 或真实 Host round-trip 证据。支持某一组合需要记录两个仓库 SHA、包/IPA 摘要、Xcode/iOS/LiveContainer 版本和三平台实际 Host 环境；表中目标版本不代表已经发布。

记录必须覆盖：配对与撤销、workspace/session CRUD、history/live、模型/权限、approval/question、files/attachment、重连及插件退出。源码推断、stub 通过和真实 Gateway/真机通过分别标记。

当前电脑上安装的实验插件 0.1.11 不属于正式组合，也未在本轮被卸载或替换。旧实验端点不承担正式产品兼容义务。
