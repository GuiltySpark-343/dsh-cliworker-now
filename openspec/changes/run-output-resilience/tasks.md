# Tasks

## 1. L0 日志按项目存放

- [x] 1.1 新增 `src/host/state-layout.ts`：项目日志目录、`.dsh/.gitignore`、不可写回退、旧文件读取回退与迁入。
- [x] 1.2 `WorkerStorage` 接入布局：时间线读写、原始流路径、`eventPath`/`logPath`/`logDirectory`、启动与每轮后的保留清理。
- [x] 1.3 `runtime.ts` 的原始流与时间线路径改走布局（含分支、遥测、重投影）；`native-supplemental-context` 校验改用实际日志目录。
- [x] 1.4 配置 `logsDirectory: project|global`（默认 project），启动时清理一次。
- [x] 1.5 单测 `tests/state-layout.test.ts`、`tests/run-log-retention.test.ts`；旧路径相关测试改用 `eventPath`。

## 2. L1 超限非致命

- [x] 2.1 `native-transport.mjs` 增加 `overflow`（默认 truncate）：超预算丢弃镜像帧并标记 `truncated`，入站超限只统计不终止。
- [x] 2.2 结果帧透传 `truncated`；`ProtocolResult` 与 `BridgeProtocol` 同步。
- [x] 2.3 宿主原始流写入达上限后停止追加但继续解析，不再抛错。
- [x] 2.4 `Worker.displayTruncated` 在轮次结束写入、下一轮开始清除；面板显示“过程已截断”。
- [x] 2.5 单测 `tests/native-transport-truncation.test.ts`；更新 `tests/core.test.ts` 的失控输出用例。

## 3. L4 失败语义

- [x] 3.1 Codex：工具条目失败改为诊断（含权限/非零退出/一般失败文案），不再 `markFailure`。
- [x] 3.2 Claude：`tool_result.is_error` 与 `permission_denials` 改为诊断；轮次级 `is_error`/`subtype` 仍失败。
- [x] 3.3 更新 `tests/native-primary-runners.test.ts` 的不变量用例，新增“仅有工具失败仍完成”的断言。

## 4. L2 降量

- [x] 4.1 Codex 进度事件：120ms/8KiB 合并、只发尾部 32 KiB、去重、去掉冗余 native 帧。
- [x] 4.2 Codex 完成事件的 `detail` 与 `publicTool` 输出截尾；Claude 工具结果截尾。
- [x] 4.3 类型检查与适配器回归通过。

## 5. L3 原始日志

- [x] 5.1 保留策略（每 Worker 默认 20 轮 / 全局 512 MiB，运行中不删，5 分钟节流）。
- [x] 5.2 只读 Remote `workerRawLog`（尾部 1 KiB–1 MiB，归属与 UUID 校验）。
- [x] 5.3 面板“查看原始日志”对话框（字节数、是否截断、尾部文本）。

## 6. 验证

- [x] 6.1 `node scripts/build.mjs --typecheck-only` 通过。
- [x] 6.2 关联单测：`state-layout`、`native-transport-truncation`、`run-log-retention`、`storage-torn-tail`、`core`、`worker-management`、`session-roster`、`dispatch-flow`、`cleanup-persistence`、`adapters`、`panel` 全部通过。
- [x] 6.3 `node scripts/build.mjs` 与预览构建通过。
- [ ] 6.4 安装到 profile 后真机验证：大输出轮次不再失败、面板出现“过程已截断”、项目 `.dsh` 下产生日志、原始日志对话框可读。
- [ ] 6.5 未验证：官方 0.8.4 合并后的冲突处理与上游 PR；Windows 以外的日志目录权限行为。
