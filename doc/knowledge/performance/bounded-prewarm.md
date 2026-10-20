# 首次预热采用有界队列并优先当前页

首次打开时预热全部已启用 CLI，让后续切页直接使用完成结果；同时限制并发，避免一次拉起所有原生查询。

`AccountQueryQueue` 默认最多运行两个键对应的任务。同一 CLI 的账号读取完成后，再顺序读取模型与思考强度目录；当前页通过 `prioritize()` 提升尚未开始任务的优先级。切页只调整等待顺序，不为抢占而终止已经进行的查询。没有启用的 CLI 不进入预热，避免给用户未使用的工具增加启动开销。

设置关闭时 `clear()` 删除等待项，并向运行项发出取消；已完成结果留在展示缓存中，重开只补缺。取消信号并不等于 Host 进程范围已经退出，队列要等原 Promise 收尾才释放并发槽。因此快速关闭、重开或刷新不能用“已调用 abort”作为无限新增查询的理由。Host 仍承担真正的子进程清理。

替换同 CLI 查询会取消旧请求并排入新请求；结果提交还需同时检查请求未取消和缓存代际未变，防止迟到响应重新填充旧来源。这个机制把“减少等待”与“保持进程数量可控”共同处理，而非只把串行改为全部并行。

实现：[AccountQueryQueue](../../../src/client/account-query-queue.ts)、[预热编排](../../../src/client/settings-dialog.tsx)；回归：[队列测试](../../../tests/account-query-queue.test.ts)、[设置页测试](../../../tests/settings-dialog.test.tsx)。

关联：[设置完成结果缓存](settings-display-cache.md)、[来源代际与局部失效](cache-invalidation.md)。
