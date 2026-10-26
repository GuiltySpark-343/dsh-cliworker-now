# Tasks

## 1. 实施

- [x] 1.1 Host 存储：`dispatch-ask.json` 读写，缺省为询问，权限 0700/0600。
- [x] 1.2 Host Remote：`dispatchAskSettings`、`setDispatchAsk`。
- [x] 1.3 `chooseDispatch`：关闭询问时使用有效项目设定，失效或不完整回退完整选型，实时授权不变。
- [x] 1.4 设置页「项目默认设置」新增“调用前询问模型”原生 Switch，不显示保存成功文字。

## 2. 自动检查

- [x] 2.1 派遣流程测试：默认询问、关闭后不弹卡片直接启动、无完整设定与失效回退、实时授权失败、对话设定失效时使用项目设定。
- [x] 2.2 存储与 Remote 测试：缺省询问、旧配置无字段、权限、项目/CLI 隔离。
- [x] 2.3 设置页测试：读取、切换保存、失败恢复。
- [x] 2.4 `build.mjs --typecheck-only`、`build-preview.mjs`、OpenSpec 严格校验。

## 3. 未执行（需另行授权或平台）

- [ ] 3.1 真实 CLI 派遣与 DSH Desktop 实际界面检查（需用户授权更新 Desktop 链接）。
- [ ] 3.2 Windows 平台界面检查。

## 4. 文档

- [x] 4.1 同步 `AGENTS.md`、README、`doc/settings-ui-design.md`。
- [x] 4.2 在 `doc/tasks.md` 记录命令、结果与未验证边界。
