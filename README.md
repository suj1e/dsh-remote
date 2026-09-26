# dsh-remote

DSH Mobile 的配套主机插件，为 macOS、Windows、Linux 上的 DeepSeek Harness 提供手机配对、设备鉴权、实例身份与官方 Remote 接入。

两个实验仓库已归档，正式产品从零建设。目前保存规划和契约设计，正式插件工程将在 M0/M1 建立；原实验 0.1.11 不代表已完成的正式产品。

- [产品职责、技术栈与实施计划](docs/PLAN-1.0.0.md)
- [接入契约与官方协议边界](PROTOCOL.md)
- [配套版本与验证状态](docs/COMPATIBILITY.md)
- [iOS 产品规格](../dsh-mobile/docs/PLAN-1.0.0.md)
- [双仓库里程碑](../dsh-mobile/docs/IMPLEMENTATION-1.0.0.md)
- [实验归档与恢复](docs/EXPERIMENT-ARCHIVE.md)

技术基线为 Cordis / 官方 DSH Gateway、Node.js、TypeScript、Fastify 5 及其成熟插件。业务能力直接使用官方 Remote；系统推送与云服务不在 1.0 范围。

安装、构建和发布命令将在正式工程可运行后补充。发布记录必须同时指明兼容的 DSH Desktop/Host、插件和 iOS 版本。
