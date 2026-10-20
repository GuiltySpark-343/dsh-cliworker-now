# 架构与数据原理索引

适用范围：v0.8.1 当前源码，核对日期 2026-10-18。这里解释实现机制；测试文件是复核入口，存在测试不等于本次已执行，更不等于所有 CLI、模型和平台都完成真实验收。

| 编号 | 原子笔记 | 解决的问题 |
|---|---|---|
| A01 | [Host、Client 与 Gateway 的职责边界](host-client-gateway.md) | 哪一层有权启动进程和写配置 |
| A02 | [Worker、Harness 与 CLI 的三类会话身份](session-identities.md) | 为什么不能只保存一个会话 ID |
| A03 | [原生会话投影与界面复用](native-session-projection.md) | 如何复用宿主聊天体验而不重复执行 |
| A04 | [工具桥按真实子 Agent 权限执行](authorized-tool-bridge.md) | CLI 怎样访问 Harness 工具和技能 |
| A05 | [公开过程只投影已公开内容](public-process.md) | 怎样展示思考与工具而不制造过程 |
| A06 | [调度同时保护 Worker 和项目目录](scheduling-locks.md) | 为什么全局并发限制还不够 |
| A07 | [停止以进程范围清理完成为准](stop-and-recovery.md) | 取消、清理、续聊与显示恢复怎样分开 |
| A08 | [账单用量与上下文占用分开计算](telemetry-semantics.md) | 积分、Token、比例和未知值怎样展示 |
| A09 | [逐轮用量依靠精确执行归属](turn-usage-attribution.md) | 运行合计如何映射到原生消息尾部 |
| A10 | [账号归属与私有存储分层保护](account-storage-isolation.md) | 缓存和恢复如何避免串账号与泄密 |
| A11 | [Worker 模型目录与宿主目录隔离](model-catalog-isolation.md) | 为什么内部路由不能出现在主聊天模型列表 |

建议先读 A01—A03 理解分层与身份，再按遇到的问题跳转。新接入 CLI 时配合[接入分类](../cli-integration/README.md)，优化交互时配合[性能分类](../performance/README.md)，验收时查[证据等级](../verification/evidence-levels.md)。

[返回知识库总索引](../README.md) · [设计演进记录](../../design.md) · [实际验收记录](../../tasks.md)
