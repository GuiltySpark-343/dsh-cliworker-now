## ADDED Requirements

### Requirement: Grok 只读任务使用原生拒绝优先权限
Grok 原生任务 SHALL 以 Grok 自身启动参数设定权限模式，且只出现一次：只读为 `dontAsk`，并以 `deny` 规则阻止 `Bash(mkdir)` 与 `Bash(touch)`；可写为 `acceptEdits`。插件 MUST NOT 以 `--permission-mode plan` 代替只读，因其仅为兼容值。只读运行中仅当 DSH 工具桥已就绪且绑定 Grok 时，SHALL 预先允许 `MCPTool(dsh_worker_tools__*)`，其他工具不预先允许。ACP 完全不列出模式时，插件 SHALL 以启动参数为准运行只读任务；ACP 列出模式时 MUST 由 ACP 提供并确认 `plan`。其他 CLI 在 ACP 未提供所需模式时 MUST 继续失败关闭。只读任务中插件 MUST 继续拒绝 CLI 发来的、非工具桥的额外权限请求。

#### Scenario: ACP 不列出模式
- **WHEN** Grok 1.0.62 的 ACP 会话不返回 `modes`，用户派遣只读 Grok 任务
- **THEN** 进程以 `--permission-mode dontAsk --deny Bash(mkdir) --deny Bash(touch)` 启动，不请求 ACP 切换模式，任务正常发送提示

#### Scenario: 只读任务尝试写入
- **WHEN** 只读 Grok 尝试写文件、`touch` 或 `mkdir`
- **THEN** Grok 原生拒绝该调用，项目中不产生文件或目录；若 Grok 仍发起审批请求，插件拒绝

#### Scenario: DSH 工具桥
- **WHEN** 只读运行的 DSH 工具桥已就绪且绑定 Grok
- **THEN** 启动参数仅额外允许 `MCPTool(dsh_worker_tools__*)`；工具桥未就绪、绑定其他 CLI 或任务可写时不加该规则

#### Scenario: ACP 列出模式
- **WHEN** ACP 返回可用模式列表
- **THEN** 只读任务必须在列表中找到并切换到 `plan`，否则在发送提示前失败

#### Scenario: 其他 CLI
- **WHEN** 其他 ACP CLI 未列出所需模式
- **THEN** 任务在发送提示前失败，不推定模式
