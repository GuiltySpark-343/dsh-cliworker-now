# Tasks

## 1. 数据与协议

- [x] 1.1 `shared/types.ts` 增加 `RosterEntry` 与 `Worker.runCount`，保持旧记录可选兼容。
- [x] 1.2 `host/storage.ts` 增加按会话持久化的 roster（标题唯一、序号分配、workerId 回填、删除），文件权限与既有存储一致。
- [x] 1.3 `host/runtime.ts` 每轮真正开始执行时累加执行次数并随 Worker 落盘（准备失败与排队取消不计数）。

## 2. 派遣与状态

- [x] 2.1 `host/index.ts` 增加 `roster` / `saveRosterEntry` / `deleteRosterEntry` / `rosterCatalog` 四个 Remote。
- [x] 2.2 `cliworker_start` 命中 roster 时走固定配置分支：不弹问题卡、CLI 冲突报错、已有 Worker 报错、模型失效报错带条目名。
- [x] 2.3 `cliworker_status` 返回 roster、Worker 状态与执行次数，并保持单 Worker 查询兼容。
- [x] 2.4 `systemPrompt` 增加按会话的存在性提示分段，无条目时不贡献文本。

## 3. 客户端

- [x] 3.1 面板顶部新增「可用智能体」区域：列表、新增、编辑、删除、状态。
- [x] 3.2 新增表单：选卡片 → 选 CLI → 模型/强度（来自已探测清单，缺省用项目偏好）→ 自动标题。
- [x] 3.3 Worker 条目展示执行次数；窄容器下降级为上下堆叠。

## 4. 验证

- [x] 4.1 关联单测：存储、标题分配、派遣绑定、状态投影、无 roster 时行为不变（`tests/session-roster.test.ts`、`tests/role-dispatch.test.ts`）。
- [x] 4.2 `pnpm typecheck` 通过；关联回归 9 个文件 325 项测试通过；全量 `pnpm test` 与改动前对比无新增失败（其余失败为 python 缺失与原生夹具环境问题）。
- [x] 4.3 `pnpm build:preview` 通过；客户端用 mock 渲染截图核对布局（`work/roster-preview/panel.png`、`form.png`）。
- [ ] 4.4 用真实宿主截图验收面板（需要宿主启动令牌；静态预览已核对）。
- [ ] 4.5 同步 `doc/role-presets.md` 与 README 的会话级说明。
- [x] 4.6 真机派遣验收：安装包重启后按 `agent_name` 派遣命中可用智能体，未弹选型卡，Worker 的 CLI/模型/强度/角色与条目一致，回复 OK，执行次数 1，条目回填 workerId（2026-10-27 实测，codex + ccs-opencode/deepseek-v4.1-flash）。
