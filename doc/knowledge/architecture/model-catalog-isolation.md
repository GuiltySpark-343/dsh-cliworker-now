# Worker 模型目录与宿主目录隔离

结论：Worker 内部路由只为原生子会话服务；主对话模型选择器与 CLI 账号模型目录属于两个独立集合。

## 机制

`CliConversationAdapter` 注册内部 provider `cliworker-native`，使真实 child Agent 有可解析的执行路由。`resolveModel` 只接受现存精确 Worker 路由；`listModels` 则明确返回空数组，避免内部 `worker/<id>` 混入普通主聊天全局目录。

Worker 输入区的原生 ModelSelect 另接当前 CLI 的精确目录和保存回调。目录来自对应账号的原生模型接口与已验证缓存，不把 Harness 的模型列表作为 CLI 候选。实际生成还需经过 Host 当前账号、路由、模型与强度核验。

## 易错边界

内部 provider 的存在不表示可以调用 DSH 模型 API。`route` 对缺失绑定、辅助生成或不匹配模型明确报错；适配器 `stream` 也拒绝未接管请求。用于详情展示的 `CLI/provider/model` 来源应来自已确认原生事件，不能把 `cliworker-native/worker/<id>` 当作实际上游模型，更不能从品牌名称猜模型。

## 源码与验证入口

- [内部适配器与路由](../../../src/host/harness-conversation.ts)：`CliConversationAdapter.listModels`、`resolveModel`、`HarnessConversationBridge.route`。
- [Client CLI 目录](../../../src/client/native-cli-model-directory.ts) · [真实来源展示](../../../src/shared/native-model-display.ts)。
- [原生控件回归](../../../tests/harness-native-controls.test.tsx) · [Host 会话回归](../../../tests/harness-conversation.test.ts) · [模型守卫回归](../../../tests/harness-model-guard.test.ts)。

关联：[职责边界](host-client-gateway.md) · [遥测口径](telemetry-semantics.md) · [账号隔离](account-storage-isolation.md) · [返回分类索引](README.md)
