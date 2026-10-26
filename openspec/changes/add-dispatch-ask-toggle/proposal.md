# Proposal

## Why

当前每个新主对话首次派遣某个 CLI 时，`src/host/index.ts` 的 `chooseDispatch` 都会用宿主 `userQuestions` 弹出问题卡：项目已有完整设定时询问“是否沿用”，否则询问模型、思考强度与角色。部分用户已在「CLI Worker 设置 → 项目默认设置」配好模型和强度，希望派遣时不再被询问，直接使用默认值。所有者要求增加开关，默认仍询问，关闭后才直接使用默认设定。

这会改变 `AGENTS.md`“首次选择前不启动任务”的约定，因此只允许一个例外：**仅在用户关闭询问，且该项目和 CLI 已有当前仍有效的完整设定时**跳过问题卡。

## What Changes

- 在每个 CLI 设置页的「项目默认设置」分区新增「调用前询问」开关（原生 Switch），按项目 + CLI 保存；默认开启（询问），即现有行为不变。
- 关闭后，新主对话派遣该 CLI 时：若项目已保存的完整设定（模型、强度、角色、账号绑定）在当前目录和账号下仍有效，直接使用，不弹“沿用”或选型问题卡；仍执行实时授权 `authorizeSelection`、宿主权限、CLI 开关与项目一致性检查。
- 没有完整设定（例如只在设置页选了模型但从未确认过角色）、设定已失效（模型不在目录、强度不支持、账号绑定变化）时，回退到现有完整选型问题卡；不猜测模型、强度或角色，不跨 CLI 套用参数。
- 当前主对话已确认的设定继续优先；其失效时，关闭询问模式先尝试项目设定，仍无效再完整选型。
- 新增 Host Remote `dispatchAskSettings` / `setDispatchAsk`，私有存储 `<key>.dispatch-ask.json`（目录 0700、文件 0600）；缺少文件或旧配置按“询问”处理。
- 同步 `AGENTS.md`、README、`doc/settings-ui-design.md`、`doc/tasks.md`。

## 范围外

- 不新增“默认角色”设置项；角色仍来自上一次完整选型保存的项目设定。
- Qoder / Qoder CN 双版本歧义询问不属于模型选型，仍照常询问。
- 同会话互斥、同目录写任务串行、并行上限、宿主规划/只读拒绝等规则不变。
- 不做真实模型调用、不更新 Desktop 链接、不升版本号。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `worker-dispatch`：新增“调用前询问开关”需求，修改“项目设定与主对话确认”以写明唯一例外。

## Impact

- Host：`src/host/storage.ts`（新存储记录）、`src/host/index.ts`（`chooseDispatch` 分支与两个 Remote）。
- Client：`src/client/settings-dialog.tsx` 新增设置行组件 `src/client/dispatch-ask-settings.tsx`，样式复用 `settingsStyles`。
- 共享协议：`src/shared/dispatch-ask.ts` 类型。
- 安装方式不变；旧数据无需迁移，缺省即询问。
