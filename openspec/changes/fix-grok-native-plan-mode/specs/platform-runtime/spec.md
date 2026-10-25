## ADDED Requirements

### Requirement: Grok 只读任务使用原生规划模式
Grok 原生任务 SHALL 以 Grok 自身启动参数设定权限模式：只读为 `plan`，可写为 `acceptEdits`，且只出现一次。ACP 完全不列出模式时，插件 SHALL 以该启动参数为准运行只读任务；ACP 列出模式时 MUST 由 ACP 提供并确认 `plan`。其他 CLI 在 ACP 未提供所需模式时 MUST 继续失败关闭。只读任务中插件 MUST 继续拒绝 CLI 的额外权限请求。

#### Scenario: ACP 不列出模式
- **WHEN** Grok 1.0.62 的 ACP 会话不返回 `modes`，用户派遣只读 Grok 任务
- **THEN** 进程以 `--permission-mode plan` 启动，不请求 ACP 切换模式，任务正常发送提示

#### Scenario: ACP 列出模式
- **WHEN** ACP 返回可用模式列表
- **THEN** 只读任务必须在列表中找到并切换到 `plan`，否则在发送提示前失败

#### Scenario: 其他 CLI
- **WHEN** 其他 ACP CLI 未列出所需模式
- **THEN** 任务在发送提示前失败，不推定模式
