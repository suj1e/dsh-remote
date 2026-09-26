# dsh-remote

DSH Mobile 的配套主机插件，为 macOS、Windows、Linux 上的 DeepSeek Harness 提供手机配对、设备鉴权、实例身份与官方 Remote 接入。

两个实验仓库已归档，正式产品从零建设。M1 插件工程基础已创建：当前是 Cordis 插件入口，加载并持久化 Host `instanceId`，包含默认拒绝的 Remote endpoint policy、共享 contract fixtures 与自动化测试。它还没有 Fastify listener、配对/撤销、设备鉴权或官方 Gateway carrier；原实验 0.1.11 不代表正式产品已完成。

- [产品职责、技术栈与实施计划](docs/PLAN-1.0.0.md)
- [接入契约与官方协议边界](PROTOCOL.md)
- [固定的共同 contract](contract/contract-v1.json) 与 [M0 wire fixtures](test/fixtures/contract-v1/README.md)
- [配套版本与验证状态](docs/COMPATIBILITY.md)
- [iOS 产品规格](../dsh-mobile/docs/PLAN-1.0.0.md)
- [双仓库里程碑](../dsh-mobile/docs/IMPLEMENTATION-1.0.0.md)
- [实验归档与恢复](docs/EXPERIMENT-ARCHIVE.md)

技术基线为 Cordis / 官方 DSH Gateway、Node.js、TypeScript、Fastify 5 及其成熟插件。业务能力直接使用官方 Remote；系统推送与云服务不在 1.0 范围。

使用 DSH 自带的 Node 24.21.0 与 pnpm 11.7，在仓库执行 `pnpm install --ignore-scripts`、`pnpm test` 可安装锁定依赖、类型构建并运行当前测试。当前测试不要求安装插件或启动 listener。发布记录必须同时指明兼容的 DSH Desktop/Host、插件和 iOS 版本；未通过三平台真实 Host 往返前，不宣称主机兼容。
