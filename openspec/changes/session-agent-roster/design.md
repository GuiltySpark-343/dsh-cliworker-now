# Design

## 模块边界

| 模块 | 职责 | 不做什么 |
| --- | --- | --- |
| `src/shared/types.ts` | `RosterEntry`（模板）协议、`Worker.templateId` / `runCount` | 不存 CLI 私有数据 |
| `src/host/storage.ts` | 按会话读写模板、标题唯一性与序号分配 | 不探测模型、不启动进程 |
| `src/host/roles.ts` | 模板实例编号（`模板1`、`模板2`…）与名称释放 | 不决定派给哪个模板 |
| `src/host/settings-catalog-cache.ts` | 只读 `saved()`，把已落盘的目录交出去 | 不刷新、不查询账号 |
| `src/host/index.ts` | 模板 Remote、`template` 派遣、状态投影、提示词、删除时释放子会话 | 不绕过既有 `querySelection` 校验 |
| `src/host/runtime.ts` | 创建实例时按模板编号命名、累加执行次数 | 不改运行与清理语义 |
| `src/client/roster.tsx` | 模板列表、创建/编辑表单、已创建实例数 | 不伪造运行状态 |

## 数据模型

模板（`RosterEntry`）只描述“用哪个 CLI、哪个模型、什么强度、什么角色提示词”，**不绑定任何 Worker**：

```json
{
  "policy": 1,
  "parent": "会话ID",
  "entries": [
    {
      "id": "uuid",
      "parentSessionId": "会话ID",
      "project": "D:/workplace/xxx",
      "title": "任务验收Agent",
      "presetId": "角色卡片ID",
      "roleSource": "preset",
      "role": { "presetId": "…", "name": "任务验收Agent", "summary": "…", "prompt": "…" },
      "cli": "codex",
      "model": "模型ID",
      "effort": "max",
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

- 一个会话一个文件（`roster-<sha256(会话)>.json`），最多 64 个模板。
- 模板名称在会话内唯一，并且不能与本会话**未删除**的 Worker 名称相同。
- Worker 记录新增可选的 `templateId`，用于统计该模板创建了哪些实例；旧 Worker 没有这个字段时按“名称前缀 + 数字”回退识别。

## 派遣

1. 主对话调用 `cliworker_start`，传 `template: "任务验收Agent"`。
2. 插件按名称解析模板；`cli` 必须与模板一致，且不得同时传 `model`/`effort`/`role`（冲突直接拒绝）。
3. `chooseDispatch` 走“固定配置”分支：不弹任何问题卡，模型/强度失效时报错并指出模板名。
4. 创建 Worker 时由 Host 分配实例名：取当前会话内该模板未被占用的最小序号（`任务验收Agent1`、`任务验收Agent2`…）。已删除（归档）的 Worker 不占名称，序号可以复用。
5. 之后仍走既有 `querySelection` 授权校验；失败即失败，不降级。
6. 每次调用都创建新实例；模板可以反复使用。

## 名称释放与子会话释放

- **名称**：`checkAgentName` 与编号分配都只统计未归档的 Worker；删除后名称立即可用。
- **DSH 子会话**：删除 Worker 时先释放它的显示子会话（`drainChildren` + `workspaces.archiveSession`），再归档 Worker；释放失败不阻断删除。插件启动时对历史上已归档但仍持有子会话的 Worker 做一次同样的释放，避免继续被计为子智能体。

## 模型清单

`rosterCatalog(sessionId, cli)` 只读 `SettingsCatalogCache.saved(project, cli)`：

- 有存档 → 返回 `{ catalog, preference }`，`preference` 是该项目该 CLI 已保存的默认模型/强度。
- 无存档 → 返回 `{ missing: true }`，客户端提示去「设置 → CLI 连接」探测，不代替用户探测。

## 提示词

注册 `systemPrompt` 分段（order 81，`interpolate: false`），按 `AssembleContext.agent.id` 读取该会话模板：

- 无模板 → 空字符串（分段被丢弃）。
- 有模板 → 一句存在性提示，说明用 `template` 参数派遣、可重复创建、续聊用 `cliworker_followup`；不列清单。

## 状态投影

`cliworker_status`（无参数）返回：

```json
{
  "roster": [{ "title": "任务验收Agent", "cli": "codex", "model": "…", "effort": "max",
               "role": "任务验收Agent", "roleSource": "preset",
               "created": 2, "workers": ["任务验收Agent1", "任务验收Agent2"] }],
  "workers": [{ "workerId": "…", "agentName": "任务验收Agent1", "status": "completed", "runs": 3 }],
  "archived": [],
  "counts": { "running": 1, "idle": 2 }
}
```

## 取舍

- **模板而不是实例**：模板与 Worker 解耦后，同一角色可以按需创建多个并行实例，删除也不影响模板。
- **编号由 Host 分配**：避免主 Agent 自己拼名字造成冲突；已删除名称可复用，编号用最小空闲值。
- **不做探测**：会话级选择完全建立在设置页的探测结果上。
- **不写全量清单进提示词**：每次派遣多一次 `cliworker_status` 调用，换取稳定前缀。
- **删除即释放**：删除 Worker 同时释放显示子会话，避免“已删除但还在子智能体列表里”。

## 生命周期与回滚

- 删除模板不删除、不停止它创建的 Worker；删除 Worker 也不影响模板。
- 模板文件独立于 Worker 记录，删除全部模板文件即回到未引入该功能的行为。
- `templateId`、`runCount` 都是可选字段，旧记录按缺省处理。
- 子会话释放失败只记录日志，不阻断删除；下次启动会重试历史记录。

## 风险

- 模型目录是“上次探测”的快照，CLI 升级后可能过期；靠派遣校验报错 + 模板内重选消化。
- 编号按“未删除 Worker”计算，归档记录会保留旧名字；列表里可能出现同名（一个已删除、一个在用），历史记录不混淆。
- 启动时批量释放历史子会话会增加一次启动开销；数量大时在后台逐条执行。
