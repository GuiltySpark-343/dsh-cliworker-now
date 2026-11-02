# 加载与交互性能索引

本分类解释如何减少重复发现、限制并发和把写入移出交互关键路径。缓存对象、作用域、失效条件与授权边界必须一起阅读。

| 笔记 | 解决的问题 |
| --- | --- |
| [模型目录持久缓存](host-catalog-cache.md) | 已验证目录如何跨窗口、跨启动留存 |
| [设置页完成结果缓存](settings-display-cache.md) | 为什么关闭重开不必重查全部账号和模型 |
| [有界预热与关闭取消](bounded-prewarm.md) | 首次预热如何兼顾当前页、并发和清理 |
| [来源代际与局部失效](cache-invalidation.md) | 如何避免换账号、路径或宿主后显示旧结果 |
| [原生元数据短期缓存](native-metadata-cache.md) | 如何减少重复辅助命令且继续核验权益 |
| [同一查询内复用 Qoder 快照](qoder-query-snapshot.md) | 账号与目录如何共享一次原生读取 |
| [设置页离开时保存草稿](settings-draft-on-leave.md) | 选择即时响应，切页及各种关闭都提交 |
| [偏好写入串行与失败重试](preference-write-order.md) | 关闭后保存、快速重开和后续编辑如何保持顺序 |
| [保存回执与迟到读取](preference-read-receipt.md) | 为什么旧设置快照不能覆盖刚保存的选择 |
| [对话选型与执行前核验](conversation-selection.md) | Worker 偏好何时保存，实时授权何时执行 |

建议按前三篇理解缓存层次，再阅读草稿、写入和回执三篇。新增 CLI 时，结合[接入索引](../cli-integration/README.md)检查其查询是否可取消、是否有写入副作用。

**当前实现区别：设置页采用“离页或关闭后保存”；Worker 对话选择仍立即保存该 Worker 的偏好，发送时重新核验账号和路由。源码尚不是“对话选择完全不落盘，发送才保存”，不能将这一目标写成已实现事实。**

macOS 与 Windows 复用这些 Host/Client 机制；平台执行发现与启动仍由各自适配层负责。实际平台验收范围见[跨平台证据](../verification/cross-platform-evidence.md)及[实施记录](../../tasks.md)。

返回[知识库总索引](../README.md)。
