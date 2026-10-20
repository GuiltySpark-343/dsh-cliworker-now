# 对话选型立即保存 Worker 偏好，发送前重新核验

当前 Worker 对话的性能优化是：从原账号绑定的已验证目录选择，不为每次打开菜单或切换选项重新发现原生账号和模型；昂贵的实时授权在实际发送前完成。**它目前仍立即保存 Worker 偏好，并未实现“发送信息才落盘”。**

原生选择器 `NativeCliModelDirectory.select()`、Worker 菜单及原生命令都调用 `configureWorker()`。Host 取得 Worker 原账号绑定，读取匹配的 `SettingsCatalogCache.display()`，确认模型与强度有效且会话空闲，随后 `runtime.configureWorker()` 调用 `storage.save()` 保存这个 Worker。已有待发消息、运行中会话或跨 CLI 改选均拒绝，避免待执行消息突然换模型。

实际新任务或续聊进入提交链路时，再由 `querySelection()` 验证当前账号、路由及精确选型，比较原绑定，核验后才提交运行。缓存选择可加快交互，但旧账号目录不能直接授权新账号执行。切模型时还清除旧上下文与观察模型投影，避免把旧统计归到新模型。

需要区分三个对象：设置页草稿在离页时写项目默认值；对话选择写当前 Worker 偏好；发送触发原生执行核验。若将来要求对话也采用仅内存草稿并发送才保存，仍需单独设计待发消息快照、重开恢复与失败回退，不能把现有目录缓存描述成已完成该行为。

实现：[原生选择器](../../../src/client/native-cli-model-directory.ts)、[Host configureWorker 与提交链路](../../../src/host/index.ts)、[Worker 保存](../../../src/host/runtime.ts)；回归：[原生选型测试](../../../tests/native-cli-model-directory.test.ts)、[授权目录测试](../../../tests/authorized-catalog.test.ts)。

关联：[目录持久缓存](host-catalog-cache.md)、[设置页离页保存](settings-draft-on-leave.md)。
