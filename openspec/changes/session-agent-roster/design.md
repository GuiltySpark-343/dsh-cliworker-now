# Design

## 模块边界

| 模块 | 职责 | 不做什么 |
| --- | --- | --- |
| `src/shared/types.ts` | `RosterEntry` 协议、`Worker.runCount` | 不存 CLI 私有数据 |
| `src/host/storage.ts` | 按会话读写 roster、标题唯一性与序号分配、Worker 执行次数落盘 | 不探测模型、不启动进程 |
| `src/host/settings-catalog-cache.ts` | 新增只读 `saved()`，把已落盘的目录交出去 | 不刷新、不查询账号 |
| `src/host/index.ts` | roster Remote、派遣绑定、`cliworker_status` 投影、提示词分段 | 不绕过既有 `querySelection` 校验 |
| `src/host/runtime.ts` | 每轮开始累加 `runCount` | 不改运行与清理语义 |
| `src/client/panel.tsx`、`src/client/roster-pane.tsx` | 面板顶部区域、创建表单、状态展示 | 不伪造运行状态 |

## 存储

`~/.dsh/cliworker-now/roster-<sha256(会话ID)>.json`：

```json
{
  "policy": 1,
  "parent": "会话ID",
  "entries": [
    {
      "id": "uuid",
      "parentSessionId": "会话ID",
      "project": "D:/workplace/xxx",
      "title": "项目执行者2",
      "presetId": "角色卡片ID",
      "roleSource": "preset",
      "role": { "presetId": "角色卡片ID", "name": "项目执行者", "summary": "…", "prompt": "…" },
      "cli": "codex",
      "model": "模型ID",
      "effort": "high",
      "workerId": "首次派遣后回填",
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

- 一个会话一个文件，最多 64 条；标题在会话内唯一（大小写不敏感），并与该会话已有 Worker 名称互斥。
- `roleSource: "preset"` 表示派遣时读取卡片当前提示词；读不到（卡片被删）回退到 `role.prompt` 快照。`"custom"` 直接使用快照。
- `workerId` 在首次派遣成功后回填；Worker 被归档后仍保留，用于展示“对话已删除”而不是静默重建。

## 派遣

1. 父 Agent 调用 `cliworker_start`，`agent_name` 命中本会话某条 roster。
2. 校验：`cli` 必须等于条目钉住的 CLI；不接受同一次调用再传 `model`/`effort`/`role`（这些已在条目里固定）。冲突直接报错，不静默覆盖。
3. 校验：条目已有 Worker 且未归档 → 报错并提示改用 `cliworker_followup`；Worker 已归档 → 报错提示恢复或另建条目。
4. `chooseDispatch` 走“固定配置”分支：只用已加载的模型目录解析条目里的模型与强度，**不弹任何问题卡**；模型不存在或该模型不支持该强度时，报错带条目名与可选值。
5. 之后仍走既有 `querySelection` 授权校验与项目/CLI 变更检查；不通过即失败，不降级。
6. 派遣成功把 `workerId` 回填到条目。

没有命中 roster 时，`cliworker_start` 的行为与现有版本完全一致。

## 模型清单

`rosterCatalog(sessionId, cli)` 只读 `SettingsCatalogCache.saved(project, cli)`：

- 有存档 → 返回 `{ catalog, preference }`，其中 `preference` 是该项目该 CLI 已保存的默认模型/强度，用作表单默认值。
- 无存档 → 返回 `{ missing: true }`，客户端提示去「设置 → CLI 连接」完成一次探测，不代替用户探测。
- 存档里的账号身份与当前不一致时仍可展示（标“上次探测”），因为真正派遣会重新校验；校验失败按普通错误呈现。

## 提示词

注册一个 `systemPrompt` 分段（order 81，`interpolate: false`），文本函数按 `AssembleContext.agent.id` 读取该会话 roster：

- 无条目 → 空字符串（分段被丢弃）。
- 有条目 → 一句存在性提示 + 指向 `cliworker_status`，不列名单。这样每轮开销固定且极小，名单增减不会造成大段前缀变动。

## 状态投影

`cliworker_status`（无参数）返回：

```json
{
  "roster": [{ "title": "项目执行者1", "cli": "codex", "model": "…", "effort": "high", "role": "项目执行者", "workerId": "…", "status": "idle" }],
  "workers": [{ "workerId": "…", "agentName": "项目执行者1", "title": "…", "cli": "codex", "status": "completed", "runs": 3, "lastResult": "…" }],
  "counts": { "running": 1, "idle": 2 }
}
```

`status` 由 `workerId`/名称与当前 Worker 快照连接得出，不额外读事件日志。

## 取舍

- **不做自动续聊**：同名第二次 `cliworker_start` 报错并提示 `cliworker_followup`，保持“start 新建、followup 续聊”的既有分工，父 Agent 按工作流自己决定何时续聊。
- **不做探测**：会话级选择完全建立在设置页的探测结果上，避免一次打开面板就拉起多个 CLI 子进程。
- **不写全量名单进提示词**：每次派遣多一次 `cliworker_status` 调用，换取稳定的提示词前缀和更小的上下文占用。
- **不自动改配置**：模型失效、CLI 停用、账号变化一律显式报错，由用户在条目里重选。

## 生命周期与回滚

- 删除 roster 条目不删除、不停止其 Worker；删除 Worker 也不删除条目。
- roster 文件独立于 Worker 记录，删除全部 roster 文件即回到当前行为，无需迁移。
- `runCount` 是可选字段，旧 Worker 记录按 0 读取；写入失败不影响运行。

## 风险

- 模型目录是“上次探测”的快照，CLI 升级后可能过期；靠派遣校验报错 + 条目内重选消化。
- 面板顶部区域在窄容器下空间紧张，需要容器查询降级为上下堆叠。
- 提示词分段按会话读取文件，增加了每次组装的一次小文件读取；用内存缓存 + 写入失效控制。
