# Design

## 不变量

1. **内容与过程分离**：CLI 轮次的成败只由轮次级证据决定（最终 result、回合状态、进程退出码、协议契约）。过程记录（镜像事件）的体量不得改变轮次结果。
2. **原始可回溯**：镜像可以截断，但原始流必须完整落盘（受保留策略约束），并按需提供只读查看。
3. **不伪造**：截断必须显式标记（Worker 的 `displayTruncated`、结果帧的 `truncated`、面板文案），不得让截断后的时间线看起来完整。

## L0 日志布局

- 全局目录（`stateDirectory`，默认 `~/.dsh/cliworker-now`）保留：Worker 记录、角色库、CLI 设置、绑定、模型目录缓存、安装备份、标记文件、锁。
- 项目目录（`<project>/.dsh/cliworker-now/logs/`）保留：`<workerId>.events.jsonl`、`<workerId>.<runId>.raw.jsonl`（含 `.stderr`）。
- 首次写入项目时创建 `<project>/.dsh/.gitignore`（内容 `*`），避免污染 git status。
- 项目不可写时回退全局目录并记录一次警告；路径解析带缓存。
- 读取优先项目路径，缺失时回退全局路径；时间线在首次追加前把旧文件迁入项目（跨盘用复制+删除），保证 `seq` 连续。
- 配置：`logsDirectory: 'project' | 'global'`（默认 project）。

## L1 超限非致命

- 桥接层（`native-transport.mjs`）：
  - 结果帧与 session 帧始终放行；其余帧在超出 `maxRunBytes` 或单帧超出 `maxLineBytes` 时丢弃并标记 `truncated`。
  - 入站字节不再触发终止；只统计，最终由轮次超时兜底。
  - `close()` 在结果帧上附加 `truncated: true`。
- 宿主（`runtime.ts`）：原始流写入达到上限后停止追加，但继续喂协议解析，不再抛错。
- 结果解析（`bridge-protocol.ts`）：把 `truncated` 透传到 `ProtocolResult`。
- Worker 记录：`displayTruncated` 在轮次结束时写入、下一轮开始时清除；面板在卡片元信息里显示“过程已截断”。
- `overflow: 'fail'` 保留旧行为（用于需要严格保真的场景）。

## L2 降量

- Codex
  - `item/commandExecution/outputDelta`：按 120ms / 8 KiB 合并；只发累计输出的尾部 32 KiB；不再额外发 native 帧。
  - `item/started`、`item/completed`：`detail` 与 native 帧里的 item 同样截尾；`aggregatedOutput` / `result` 在 `publicTool` 中截尾。
- Claude：`tool_result` 的 `detail` 与 `toolCall.output` 截尾 32 KiB。
- 截断标记：被截断的载荷以“（前 N 字符已省略）”开头，面板可识别。

## L3 原始日志

- 原始流已按轮存放；保留策略：每 Worker 保留最近 20 轮，全局上限 512 MiB，最旧的先删；运行中的轮次永不删除；每 5 分钟最多扫描一次。
- 新增只读 Remote `workerRawLog(parentSessionId, workerId, runId, tailBytes, signal)`：校验归属与 UUID，读取尾部（1 KiB–1 MiB，默认 256 KiB），返回 `{ size, truncated, text }` 或 `{ missing: true }`。
- 面板“查看原始日志”打开对话框，显示字节数与“仅尾部”提示。

## L4 失败语义

- Codex：工具条目失败只发诊断（含失败原因：权限/审批拒绝、非零退出、执行失败），不再调用 `markFailure`；回合状态非 completed、进程非零退出、协议违约仍然失败。
- Claude：`tool_result.is_error` 与 `permission_denials` 改为诊断；`result.is_error` / `subtype != success` 仍然失败。
- 未完成的工具（回合结束时仍 running）仍视为协议异常并失败。

## 兼容与回滚

- 所有新配置都有默认值，旧配置文件无需修改。
- `logsDirectory: 'global'` 即恢复单目录行为；旧日志不被删除，只在读取时回退。
- `overflow: 'fail'` 恢复“超限即终止”。
