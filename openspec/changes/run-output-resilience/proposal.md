# Run output resilience

## Why

真实使用中两类失败都不是内容失败：

1. 单轮输出超过 16 MiB 上限时，桥接层抛错并终止 CLI 进程——即使工作已经完成、只是过程记录太多。
2. 任何工具条目非零退出（包括 `grep` 无匹配、检查脚本返回 1）都会把整轮标成 failed，错误文案统一写成“权限被拒绝”。

同时，大文件全部落在系统盘（`~/.dsh/cliworker-now/`），与项目无关且持续增长。

## What Changes

- **L0 日志按项目存放**：`<project>/.dsh/cliworker-now/logs/` 存事件与原始流；元数据、预设、绑定仍留全局目录；不可写时回退全局；旧文件可继续读取并迁移。
- **L1 超限非致命**：新增 `overflow: truncate|fail`（默认 truncate）。truncate 模式下超出预算只停止镜像、保留 CLI 轮次与最终结果，并在结果帧标记 `truncated`；Worker 上标记 `displayTruncated`，面板显示“过程已截断”。
- **L2 降量**：Codex 进度事件只发尾部、合并增量、去掉重复载荷与冗余 native 帧；Claude 工具结果同样截尾。单轮事件体积下降一到两个数量级。
- **L3 原始日志**：保留策略（每 Worker 20 轮 / 全局 512 MiB），新增只读 Remote `workerRawLog`，面板可查看当前轮原始日志尾部。
- **L4 失败语义**：工具失败或权限拒绝记为诊断，不再判整轮失败；轮次级信号（回合状态、进程退出码、协议违约）仍然失败。

## Impact

- 受影响的 spec：`worker-run-outcomes`、`worker-management`
- 受影响的代码：`storage.ts`、`runtime.ts`、`native-transport.mjs`、`native-codex.mjs`、`native-claude.mjs`、`bridge-protocol.ts`、`index.ts`、`state-layout.ts`（新增）、客户端 worker 卡片与原始日志对话框
- 兼容性：`logsDirectory`、`overflow`、`rawRetention*` 都有默认值；旧日志按回退路径读取，时间线首次追加时迁移
