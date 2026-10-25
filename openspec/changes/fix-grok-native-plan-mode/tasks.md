## 1. 实现

- [x] 1.1 `grokAcpArgv` 按任务模式替换 `--permission-mode`（只读 `plan`、可写 `acceptEdits`）。
- [x] 1.2 `runNativeAcp`：`argvModes` 声明的模式在 ACP 完全不列出模式时不要求 ACP 切换；列出模式时照旧确认。

## 2. 自动检查

- [x] 2.1 `tests/native-acp.test.ts`：无模式 ACP 下只读 Grok 以 `--permission-mode plan` 成功且不调用 `session/set_mode`（撤掉修复时失败）；列出模式时仍切换 `plan`；Kimi 无模式仍在提示前失败。
- [x] 2.2 真实只读探针：Grok 1.0.62 以 `--permission-mode plan agent --no-leader stdio` 在临时 GROK_HOME 完成 initialize 与 session/new，不发送提示。
- [x] 2.3 全量 225 文件 4407 通过、13 跳过；`build:preview` 通过；OpenSpec 严格校验通过。

## 3. 真实验收

- [ ] 3.1 Desktop 派遣只读 Grok 任务成功；要求其创建文件时不产生文件（需用户授权模型调用）。
