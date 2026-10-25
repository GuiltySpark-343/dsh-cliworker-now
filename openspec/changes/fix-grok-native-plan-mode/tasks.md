## 1. 实现

- [x] 1.1 `grokAcpArgv` 按任务模式替换 `--permission-mode`（只读 `plan`、可写 `acceptEdits`）。
- [x] 1.2 `runNativeAcp`：`argvModes` 声明的模式在 ACP 完全不列出模式时不要求 ACP 切换；列出模式时照旧确认。

## 2. 自动检查

- [x] 2.1 `tests/native-acp.test.ts`：无模式 ACP 下只读 Grok 以 `--permission-mode plan` 成功且不调用 `session/set_mode`（撤掉修复时失败）；列出模式时仍切换 `plan`；Kimi 无模式仍在提示前失败。
- [x] 2.2 真实只读探针：Grok 1.0.62 以 `--permission-mode plan agent --no-leader stdio` 在临时 GROK_HOME 完成 initialize 与 session/new，不发送提示。
- [x] 2.3 全量 225 文件 4407 通过、13 跳过；`build:preview` 通过；OpenSpec 严格校验通过。

## 3. 真实验收

- [x] 3.1 Desktop 派遣只读 Grok 任务成功；要求其创建文件时不产生文件（需用户授权模型调用）。
  - 2026-10-25 22:52（94bfec4 正式构建，新 Host 17:21），用户授权；Codex gpt-6-astra high 驱动界面，同一请求并行派遣 2 个只读 Grok（grok-4.6·low），同项目 `cliworker-isolation-test`，相隔 0.07 秒创建、22:52:36 同时连接，未出现 `EEXIST` 或 `ACP does not advertise the selected permission mode`，界面访问模式为「规划（只读）」。grok-7 问好：completed，回复「你好。」，无工具调用。grok-8 写文件：Grok 在 plan 模式下仍发起 `session/request_permission`（write，选项 allow-edits-session / allow-once / reject-once），插件记录「CLI 额外权限请求已拒绝」，工具 failed（User rejected the execution for tool `write`），Grok 以 `stopReason: cancelled`（cancellationCategory PermissionRejected）结束本轮，任务 failed「CLI 未成功完成（cancelled）」。项目文件派遣前后 shasum 一致，`grok-readonly-probe.txt` 不存在。
  - 说明：Grok 1.0.62 的 plan 模式不会自行阻止写工具，只读边界由插件拒绝额外权限保证；拒绝后 Grok 取消整轮，因此写入被拒的只读任务显示为失败而非带说明的完成。
  - 后续核实官方文档：`--permission-mode plan` 只是兼容值，不是 Grok 规划模式；`mkdir`/`touch` 在所有模式下免审批，原方案拦不住。用户决定改为 `dontAsk` 加 deny 规则（第 4、5 节）。

## 4. 改为 dontAsk 加 deny 规则

- [x] 4.1 `grokAcpArgv` 只读改为 `--permission-mode dontAsk --deny Bash(mkdir) --deny Bash(touch)`；可写仍为 `acceptEdits`。
- [x] 4.2 只读且 DSH 工具桥就绪、绑定 Grok 时追加 `--allow MCPTool(dsh_worker_tools__*)`；抽出 `nativeHarnessReadyConnection` 与 ACP 审批共用判断。
- [x] 4.3 `tests/native-acp.test.ts`：只读完整 argv、可写不含 deny/allow 且只有一个权限模式、工具桥 allow 仅在就绪且绑定 Grok 的只读运行出现；插件拒绝审批兜底测试保持通过。
- [x] 4.4 真实无提示探针：Grok 1.0.62 以只读参数（含/不含工具桥 allow）及可写参数在临时 GROK_HOME 完成 initialize 与 session/new。
- [x] 4.5 全量两次：4403/4405 通过、13 跳过，分别有 6/4 项失败且每次不同（`native-zcode`、`native-harness-tools` 的子进程用例，机器负载约 22）；两文件单独运行 56/56 通过。类型检查、`build:preview`、OpenSpec 严格校验通过。

## 5. 真实验收（用户已授权）

- [ ] 5.1 Desktop 并行派遣 4 个只读 Grok：问好、写文件、`touch`、`mkdir`；核对事件、退出状态与项目文件。
- [ ] 5.2 只读运行调用 DSH 工具桥（未授权，未执行）。
