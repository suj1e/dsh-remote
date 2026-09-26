# 实验归档与恢复

归档时间：2026-09-26。用户确认 dsh-mobile 与 dsh-remote 是实验探测仓库，正式产品从零建设。

本机可恢复归档：

    /Users/sujie/workspace/dev/jack/dsh-experiments-20260926.ryqnQn/

- dsh-mobile/：App、DshMobile.xcodeproj、SelfCheck、Tests、build、scripts 与原 .gitignore；包含归档前尚未提交的四个 Swift 页面修改。
- dsh-remote/：src、test、scripts、配置/包清单/锁文件、.github、lib、node_modules、原 README/PROTOCOL 与 .gitignore。

两仓库的 .git 和历史保留在原位置。归档前 HEAD：
- dsh-mobile：6088c68a9fc12afe08f419f1c71ba96430a580f8
- dsh-remote：c1071c426e34fc3919914cfa1bb743d366afd353

恢复时从归档复制所需文件到独立目录查看，或有选择地恢复到对应仓库；不要覆盖正在建设的正式文档和工程。原先已提交的版本也可通过 Git 历史查看。归档为本机目录，不会随 Git push 上传。

正式规划文档继续保留在当前仓库。旧代码不要求迁移或继续支持；本机已安装的 DeepSeek Harness、实验插件及用户 DSH 数据没有被卸载、更改或删除。
