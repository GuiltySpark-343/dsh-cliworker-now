## 0. 调研与实测

- [x] 0.1 静态源码调研 12 个 CLI 的登录/退出流程（`scratchpad/login-research.md`）。
- [ ] 0.2 隔离目录真实 PTY 探测（不碰真实账号，只按回车/方向键，不提交授权码或密钥），回填映射表与 `doc/tasks.md`。

## 1. 实现：引擎、协议与模板（阶段 A）

- [ ] 1.1 `src/shared/accounts.ts`：`AccountGuide.template/code/options`、`AccountLogin.id/source/removable/group`、`AccountActionDescriptor.providers`。
- [ ] 1.2 `src/host/account-guide/engine.ts`：通用引擎；Antigravity 迁入并保持现有测试通过。
- [ ] 1.3 Gateway：`accountRespond`、`accountStartWith`（兼容 `accountStartForProvider/Source`）。
- [ ] 1.4 `src/client/account-login/`：窗口外壳与模板组件；`account-terminal.tsx` 改为通用；样式、词条。
- [ ] 1.5 无法识别画面的后备（D8）。

## 2. 实现：各 CLI 接入

- [ ] 2.1 单账号：Codex、Claude Code、Qoder/Qoder CN、MiMo、Grok —— 登录模板、自动退出、切换账号。
- [ ] 2.2 多服务商：ZCode、Kimi、OpenCode —— 下拉框、账号窗口、逐个退出。
- [ ] 2.3 Pi、OMP、Hermes —— 下拉框、添加/替换、账号窗口、逐个退出。

## 3. 自动检查

- [ ] 3.1 每个流程定义的合成画面测试（标注模拟）：步骤推进、回应翻译、退出写入范围、确认条件、白名单链接。
- [ ] 3.2 窗口组件测试：各模板、下拉框、切换账号、账号窗口逐行退出与确认。
- [ ] 3.3 全量测试、类型检查、OpenSpec 严格校验、隔离构建。

## 4. 真实验收（用户本人登录）

- [ ] 4.1 至少每类一个 CLI 真实登录与退出（单账号、多服务商、同服务商多账号），记录原生状态证据。
- [ ] 4.2 其余 CLI 列出未实测项。

## 5. 文档

- [ ] 5.1 `doc/settings-ui-design.md`（模板与账号窗口规则）、`doc/usage-details.md`、`doc/design.md`、README、`doc/tasks.md`。
