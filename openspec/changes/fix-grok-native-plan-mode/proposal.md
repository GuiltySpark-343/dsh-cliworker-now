## Why

2026-10-25 Desktop 复验（`fix-parallel-account-waits` 4.2）中，3 个只读 Grok 任务均在原生会话建立后失败：`ACP does not advertise the selected permission mode`。

本机证据：

- 失败任务原始帧：Grok 1.0.62 的 ACP `session/new` 只返回 `sessionId`、`models`、`configOptions`（仅 `model`、`reasoning_effort`）和 `_meta`，`modes` 为空；会话详情 `kind` 为 `build`。插件只读时要求 ACP 列出并切换 `plan` 模式，因此在发送提示前失败。
- `grok --help`（1.0.62）的 `--permission-mode` 可选值包含 `plan`。在临时 GROK_HOME（仅登录链接）以 `--permission-mode plan agent --no-leader stdio` 启动，只做 initialize 与 session/new、不发送提示：会话正常建立，同样不列出模式。
- 可写任务已按同一方式由原生启动参数 `--permission-mode acceptEdits` 设定，从不虚构 ACP 模式。只读原先传 `--permission-mode default` 并依赖 ACP 切换。

- 首版以 `--permission-mode plan` 修复后，Desktop 复验中 Grok 对写文件仍发起审批请求（由插件拒绝）。随 1.0.62 安装的官方文档 `~/.grok/docs/user-guide/22-permissions-and-safety.md` 说明：`plan` 只是为兼容 Claude 设置而接受的值，不是 Grok 的规划模式；`dontAsk` 只运行预先允许的工具与内置只读处理，其余直接拒绝；`mkdir`、`touch` 在包括 `dontAsk` 的所有模式下都免审批，只能用 `deny` 规则阻止，`deny` 优先于所有模式与 allow 规则。

## What Changes

- Grok 原生 ACP 启动参数按任务模式设置 Grok 自身权限模式：只读为 `--permission-mode dontAsk --deny 'Bash(mkdir)' --deny 'Bash(touch)'`，可写为 `acceptEdits`；替换而不是重复原参数。
- `dontAsk` 不再经 ACP 审批回调询问，只读运行中已就绪且绑定 Grok 的 DSH 工具桥改为以 `--allow 'MCPTool(dsh_worker_tools__*)'` 预先允许（与 Claude 的 `--allowedTools` 一致），每次执行仍由 Host 审批；工具桥未就绪或可写任务不加该规则。
- ACP 完全不列出模式时，只有由启动参数确定该模式的 CLI（Grok 的 `plan`）可跳过 ACP 切换；列出了模式的 ACP 仍必须提供并确认 `plan`，其他 CLI 照旧失败关闭。
- 只读任务中插件继续拒绝 Grok 的所有额外权限请求（DSH 工具审批链不变）；不新增操作系统沙箱。旧非原生路径不变。

## Capabilities

### Modified Capabilities

- `platform-runtime`：新增“Grok 只读任务使用原生拒绝优先权限”。

## Impact

- Host：`src/host/native-grok.mjs`、`src/host/native-acp.mjs`、`src/host/native-harness-injection.mjs`。
- 测试：`tests/native-acp.test.ts`。
