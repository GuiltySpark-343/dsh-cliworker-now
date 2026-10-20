# 模型与思考强度接入

模型和思考强度只能来自该 CLI 当前来源实际公开的目录，并在执行时解析为真实原生 ID。

## 1、机制与实施要点

共享 `ModelChoice` 分开保存执行 `id`、显示 `label`、可选 `efforts`，必要时用 `variants` 保存各强度对应的真实模型 ID。`resolveModel` 同时验证模型和强度，缺失或不再支持就要求重选。

Antigravity 的展示分组只合并目录明确发布的变体，不按模型名推测缺失强度。Qoder 目录使用原生结构化配置，不从显示表格猜执行 ID。新 CLI 应先确定强度属于参数、配置项还是不同模型 ID，再实现自己的映射。

项目默认偏好、某个 Worker 的偏好和当前运行实际观察模型分别保存；切换界面选择不代表远端已切换。目录缓存与延后保存用于减少交互等待，真实发送仍需核验当前账号、路由和准确选型。

## 2、易错边界

Host 主对话模型目录与 Worker CLI 目录分属不同来源，不能互相混入。不得默认取第一项、把共享 `EFFORTS` 全部显示，或在没有用户首次选型时启动任务。显示名称不能用于替代执行 ID。

## 3、源码与验证入口

- [模型目录结构](../../../src/shared/types.ts)：`ModelChoice`、`Preference`。
- [分组与精确解析](../../../src/shared/models.ts)：`groupAgyModels`、`resolveModel`。
- [目录发现与选型校验](../../../src/host/adapters.ts)。
- [主对话模型边界](../../../src/host/harness-model-guard.ts)、[模型边界回归](../../../tests/harness-model-guard.test.ts)、[模型展示回归](../../../tests/model-presentation.test.ts)。

## 4、关联笔记

[账号绑定](account-binding.md) · [原生数据接口](native-data-interfaces.md) · [原生会话](native-conversation-integration.md)
