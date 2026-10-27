## ADDED Requirements

### Requirement: 可用智能体绑定派遣
当 `cliworker_start` 的 `agent_name` 命中当前会话的可用智能体时，插件 SHALL 使用该条目固定的 CLI、模型、思考强度与角色完成派遣，MUST NOT 再弹出模型、思考强度或角色问题卡，也 MUST NOT 在本次调用中接受与条目冲突的 `model`、`effort` 或 `role`。`cli` 与条目不一致时 MUST 在启动前拒绝并说明条目固定的 CLI。名称命中但该条目已创建过 Worker 时，MUST 拒绝新建并提示改用续聊工具。条目固定的模型或强度在当前目录中不可用时，MUST 报错并指出条目名称与可选值，不得静默改用其他模型。

#### Scenario: 按名称派遣
- **WHEN** 用户已创建“项目执行者2”（Codex／指定模型／高强度），主 Agent 以该名称调用派遣
- **THEN** 插件使用该配置直接启动，不产生任何选择卡片，返回的 Worker 名称即该条目名称

#### Scenario: CLI 不一致
- **WHEN** 主 Agent 以该条目名称调用派遣，但传入的是另一个 CLI
- **THEN** 派遣在启动前被拒绝，错误说明该条目固定的 CLI

#### Scenario: 条目已创建过 Worker
- **WHEN** 该名称的 Worker 已存在（运行中、已完成或已归档）
- **THEN** 不新建 Worker，提示用续聊工具继续，或恢复／另建条目

#### Scenario: 固定模型失效
- **WHEN** 条目固定的模型在当前目录中不存在，或该模型不支持条目固定的思考强度
- **THEN** 派遣失败并指明条目名称与不可用的原因，不改用其他模型或强度执行

#### Scenario: 未命中可用智能体
- **WHEN** `agent_name` 不与任何可用智能体重名
- **THEN** 派遣行为与未引入该能力时一致，包括既有的名称唯一性检查
