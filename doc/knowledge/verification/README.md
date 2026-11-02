# 验证与交付索引

本分类说明如何判断实现是否有效，以及如何把相同的源码交付给实际运行环境。它记录方法，不汇总历次测试数字。

| 原子笔记 | 解决的问题 |
| --- | --- |
| [验证证据分层](evidence-levels.md) | 目录可读、模拟测试、实机进程、Desktop 交互和模型生成分别能证明什么 |
| [按影响范围选择最小验收](minimal-acceptance.md) | 日常修复需要执行哪些检查 |
| [隔离构建与 Desktop 更新](isolated-build-and-desktop.md) | 如何避免构建覆盖正在使用的插件 |
| [跨平台验证的证据边界](cross-platform-evidence.md) | Mac 构建、Windows 测试和 Windows Desktop 验收的区别 |
| [构建依赖与随包原生资源校验](source-package-contract.md) | 如何防止 SDK 混用、漏包及原生界面资源不匹配 |
| [规格、原理与历史记录分工](specs-and-history.md) | 实现变化后应同步哪些文档 |

阅读顺序：先明确[证据](evidence-levels.md)，再选[最小检查](minimal-acceptance.md)，涉及安装时继续阅读[构建与更新](isolated-build-and-desktop.md)。

[返回知识库](../README.md) · [返回文档索引](../../README.md)
