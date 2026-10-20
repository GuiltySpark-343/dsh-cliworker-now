# Worker、Harness 与 CLI 的三类会话身份

结论：业务任务、宿主显示会话和 CLI 原生会话各有独立身份；恢复、停止和统计必须沿精确绑定查找，不能靠文本相同或时间接近推断。

## 机制

| 身份 | 用途 |
|---|---|
| `workerId` 与 `parentSessionId` | 标识插件任务及所属父对话，执行所有权校验 |
| Harness child Session ID | 承载真实 `origin: subagent` 的原生消息、Inbox 与显示投影 |
| CLI conversation/session ID | 交给对应 CLI 续聊，保持其原生历史与上下文 |
| `runId`、RPC request ID、batch ID | 区分每次执行、原生输入及合批接收回执 |

Host 保存这些关系；Client `readHarnessConversationBinding` 和 `sessions.retain` 再核对父子引用。每轮执行即使复用同一个 Worker 和 CLI 会话，也会拥有自己的 run ID。消息接收回执以原生 RPC 身份去重，合批后重试其中一条不会成为新任务。

## 易错边界

显示会话损坏时可以在受保护条件下更换 Harness child 绑定，但不能顺带更换 CLI 会话或重跑原 prompt。Worker 名称、模型名、prompt hash 都不是会话身份。相同项目也不构成跨父会话授权。

## 源码与验证入口

- [绑定与路由](../../../src/host/harness-conversation.ts)：`HarnessConversationBridge`、`harnessConversationBinding`。
- [私有绑定存储](../../../src/host/harness-conversation-store.ts)：`nativeInputs`、`turnRuns` 的校验；[Client 绑定](../../../src/client/harness-conversation.tsx)：`readHarnessConversationBinding`。
- [绑定回归](../../../tests/harness-conversation-store.test.ts) · [原生 Inbox 回归](../../../tests/harness-conversation-inbox.test.ts)。

关联：[原生会话投影](native-session-projection.md) · [逐轮用量归属](turn-usage-attribution.md) · [返回分类索引](README.md)
