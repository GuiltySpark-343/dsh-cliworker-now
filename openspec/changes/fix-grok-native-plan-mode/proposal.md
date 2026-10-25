## Why

2026-10-25 Desktop 复验（`fix-parallel-account-waits` 4.2）中，3 个只读 Grok 任务均在原生会话建立后失败：`ACP does not advertise the selected permission mode`。

本机证据：

- 失败任务原始帧：Grok 1.0.62 的 ACP `session/new` 只返回 `sessionId`、`models`、`configOptions`（仅 `model`、`reasoning_effort`）和 `_meta`，`modes` 为空；会话详情 `kind` 为 `build`。插件只读时要求 ACP 列出并切换 `plan` 模式，因此在发送提示前失败。
- `grok --help`（1.0.62）的 `--permission-mode` 可选值包含 `plan`。在临时 GROK_HOME（仅登录链接）以 `--permission-mode plan agent --no-leader stdio` 启动，只做 initialize 与 session/new、不发送提示：会话正常建立，同样不列出模式。
- 可写任务已按同一方式由原生启动参数 `--permission-mode acceptEdits` 设定，从不虚构 ACP 模式。只读原先传 `--permission-mode default` 并依赖 ACP 切换。

## What Changes

- Grok 原生 ACP 启动参数按任务模式设置 Grok 自身权限模式：只读为 `--permission-mode plan`，可写为 `acceptEdits`；替换而不是重复原参数。
- ACP 完全不列出模式时，只有由启动参数确定该模式的 CLI（Grok 的 `plan`）可跳过 ACP 切换；列出了模式的 ACP 仍必须提供并确认 `plan`，其他 CLI 照旧失败关闭。
- 只读任务中插件继续拒绝 Grok 的所有额外权限请求（DSH 工具审批链不变）；不新增操作系统沙箱。旧非原生路径不变。

## Capabilities

### Modified Capabilities

- `platform-runtime`：新增“Grok 只读任务使用原生规划模式”。

## Impact

- Host：`src/host/native-grok.mjs`、`src/host/native-acp.mjs`。
- 测试：`tests/native-acp.test.ts`。
