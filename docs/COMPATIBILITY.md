# 正式版本兼容矩阵

更新：2026-09-26。当前没有完成正式端到端验证的发布组合。

| iOS | 插件 | 官方 DSH / Remote | contract ID | macOS | Windows | Linux | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.0.0 目标（未构建） | 1.0.0 目标（未构建） | 0.1.7-rc.2 候选基线 | `dshr-v1-dsh-0.1.7-rc.2-2026-09-26` | 待验证 | 待验证 | 待验证 | 安装包源码已核对；Host round-trip 未运行 |

两个仓库的 `contract-v1.json` 与 wire-shape fixtures 已建立且一致；插件 Node 7 项、Swift XCTest 8 项、iOS 26 target build 通过。证据覆盖静态官方源码、DTO 和本地 multipart parser，不推出 HTTP adapter、WS mux、上传或任一 OS 已兼容。支持某一组合需要记录两个仓库 SHA、包/IPA 摘要、Xcode/iOS/LiveContainer 版本和三平台实际 Host 环境；表中目标版本不代表已经发布。

记录必须覆盖：配对与撤销、workspace/session CRUD、history/live、模型/权限、approval/question、files/attachment、重连及插件退出。源码推断、stub 通过和真实 Gateway/真机通过分别标记。

当前电脑上安装的实验插件 0.1.11 不属于正式组合，也未在本轮被卸载或替换。旧实验端点不承担正式产品兼容义务。
