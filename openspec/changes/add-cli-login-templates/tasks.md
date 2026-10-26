## 0. 调研与实测

- [x] 0.1 静态源码调研 12 个 CLI 的登录/退出流程（`scratchpad/login-research.md`）。
- [x] 0.2 隔离目录真实 PTY 探测（不碰真实账号，只按回车/方向键，不提交授权码或密钥），回填映射表与 `doc/tasks.md`：Codex、Claude Code、Qoder / Qoder CN、MiMo、ZCode、Grok、OpenCode、Pi、OMP、Hermes。OpenCode 与 Hermes 的单条退出用隔离目录中的模拟凭据实测。
- [ ] 0.3 仍未捕获：Kimi 全部画面（Codex 沙箱内 EMFILE / DNS 失败）；Qoder 已登录 TUI 与 `/logout` 画面；Pi / OMP / Kimi 非空的退出菜单。

## 1. 实现：引擎、协议与模板（阶段 A）

- [x] 1.1 `src/shared/accounts.ts`：`AccountGuide.template/plan/stage/code/options`、`AccountLogin.id/source/group`、`AccountActionDescriptor.providers`。可单独退出以是否带 `id` 表示，没有另设 `removable`。
- [x] 1.2 `src/host/account-guide/engine.ts`：通用引擎；Antigravity 迁入并保持现有测试通过。
- [x] 1.3 Gateway：`accountRespond`、`accountStartWith`（兼容 `accountStartForProvider/Source`）。
- [x] 1.4 `src/client/account-login/`：登录窗口与模板、「账号」窗口；`account-terminal.tsx` 改为通用；样式、词条。
- [x] 1.5 无法识别画面的后备（D8）。

## 2. 实现：各 CLI 接入

- [x] 2.1 单账号：Codex、Claude Code、Qoder/Qoder CN、MiMo、Grok —— 登录模板、自动退出、切换账号。
- [x] 2.2 ZCode：「登录到」BigModel / Z.AI，账号窗口中两家合为一行一起退出。OpenCode：「登录到」常用服务商（API Key），每个服务商单独退出。
- [x] 2.3 Hermes：「登录到」API Key 服务商，同服务商「添加另一个凭据 / 替换」（先确认新凭据再移除旧凭据），每条凭据单独退出。
- [ ] 2.4 Kimi、Pi、OMP：账号窗口已列出账号，添加和退出仍进入原生终端菜单；「登录到」与逐条退出待 0.3 的画面实测后再做。OMP 同服务商添加/替换、Pi/OMP 账号行按原生目录 / 插件目录分组同样待做（目前只在列表下方按来源提供原生退出入口）。

## 3. 自动检查

- [x] 3.1 每个流程定义的合成画面测试（标注模拟）：步骤推进、回应翻译、退出写入范围、确认条件、白名单链接。
- [x] 3.2 窗口组件测试：各模板、下拉框、切换账号、账号窗口逐行退出与确认、替换顺序。
- [x] 3.3 全量测试、类型检查、OpenSpec 严格校验、隔离构建。

## 4. 真实验收（用户本人登录）

- [ ] 4.1 至少每类一个 CLI 真实登录与退出（单账号、多服务商、同服务商多账号），记录原生状态证据。
- [ ] 4.2 其余 CLI 列出未实测项。

## 5. 文档

- [x] 5.1 `doc/settings-ui-design.md`（模板与账号窗口规则）、`doc/usage-details.md`、`doc/design.md`、README、`doc/tasks.md`。
