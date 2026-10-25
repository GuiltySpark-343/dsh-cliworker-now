## 1. 实现

- [x] 1.1 ZCode：`denied` 标记、被拒工具与批次失败豁免、UNCERTAIN 结果。
- [x] 1.2 ACP（Kimi/Grok/Qoder/Qoder CN）：同上，按 `toolCall.toolCallId` 豁免。
- [x] 1.3 Codex：仅三类审批请求转为 `denied`，被拒条目 `declined` 完成不判失败；其他反向请求仍失败。（Codex 子代理 gpt-6.1-sol 实施，主会话补充被拒条目豁免）
- [x] 1.4 Hermes、原生 HTTP 会话系：有拒绝时为 UNCERTAIN，无拒绝的工具失败仍失败。（Codex 子代理 gpt-6.1-sol 实施）

## 2. 测试

- [x] 2.1 `tests/native-zcode.test.ts`：按实测帧顺序拒绝后完成→UNCERTAIN；拒绝后轮次失败、批内其他工具失败→ERROR。
- [x] 2.2 `tests/native-acp.test.ts`、`tests/native-qoder.test.ts`：拒绝→UNCERTAIN；被拒工具失败不影响；其他工具失败→ERROR。
- [x] 2.3 `tests/native-primary-runners.test.ts`：三类审批→UNCERTAIN；用户输入/未知请求、拒绝后失败/中断/工具失败/非零退出→ERROR。
- [x] 2.4 `tests/native-http.test.ts`：OpenCode 系与 Hermes 拒绝→UNCERTAIN；无拒绝工具失败→ERROR。

## 3. 未执行

- [ ] 3.1 真实 ZCode 复验：拒绝 shell 后改用编辑完成，任务卡显示结果待核实。
- [ ] 3.2 其他 CLI 真实拒绝场景（未调用真实模型）。
