## ADDED Requirements

### Requirement: 模板派遣
当 `cliworker_start` 传入当前会话已存在的模板名 `template` 时，插件 SHALL 使用该模板固定的 CLI、模型、思考强度与角色创建新的 Worker，MUST NOT 弹出模型、思考强度或角色问题卡，也 MUST NOT 接受与模板冲突的 `model`、`effort`、`role`。`cli` 与模板不一致、模板不存在或模板固定的模型/强度已不可用时，MUST 在启动前拒绝并说明原因，不得静默改用其他配置。

#### Scenario: 按模板派遣
- **WHEN** 用户已创建模板「任务验收Agent」（Codex／指定模型／max），主 Agent 以该模板名调用派遣
- **THEN** 插件使用该配置直接启动，不产生任何选择卡片，Worker 名称为模板名加序号

#### Scenario: CLI 不一致
- **WHEN** 主 Agent 按模板派遣，但传入的是另一个 CLI
- **THEN** 派遣在启动前被拒绝，错误说明模板固定的 CLI

#### Scenario: 固定模型失效
- **WHEN** 模板固定的模型在当前目录中不存在，或该模型不支持模板固定的思考强度
- **THEN** 派遣失败并指明模板名称与不可用的原因，不改用其他模型或强度执行

#### Scenario: 未使用模板
- **WHEN** 调用未传 `template`
- **THEN** 派遣行为与未引入该能力时一致，包括既有的选型卡与名称唯一性检查
