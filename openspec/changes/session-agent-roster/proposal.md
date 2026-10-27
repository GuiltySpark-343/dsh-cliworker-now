# Proposal

## Why

现在同一个会话里想要三个并行的“项目执行者”，分别跑 Codex、Claude 和另一个模型时，父 Agent 只有两条路：每次派遣前弹一次模型/强度/角色问题卡，或每次调用临时传 `model`/`effort`/`role`。两种方式都不能把“这个会话里我有哪些固定搭档、各自钉在哪个 CLI 和模型上”沉淀下来：配置散落在多次调用里、无法在面板里查看，也无法在复核不通过回到设计时复用同一套身份。

模型清单已经由「设置 → CLI 连接」探测并落盘（`settings-catalogs/<hash>.json`），会话级选择没有任何理由再次探测。

## What Changes

- 新增会话级「可用智能体」：从智能体设置的角色卡片实例化，钉住 CLI、模型、思考强度与角色提示词；同一张卡片可创建多个，标题取“卡片名 + 序号”。
- 父 Agent 按名称派遣：`cliworker_start` 的 `agent_name` 命中本会话可用智能体时，直接使用其固定配置，不再弹模型/强度/角色问题卡；`cli` 与之不一致、模型已不可用或该名称已创建过 Worker 时明确报错，不静默改配置。
- 角色提示词默认跟随卡片，条目内编辑后转为自定义并保留最后一次快照兜底。
- 模型清单只读「设置 → CLI 连接」已探测并落盘的目录缓存，本功能不新增任何 CLI 探测或账号查询。
- `cliworker_status` 扩展为一次返回可用智能体清单、各 Worker 状态与执行次数，供主 Agent 每次判断时使用。
- Worker 记录新增执行次数，面板按 CLI 分组的 Agent 条目展示。
- 系统提示词只注入一句存在性提示（有可用智能体时），不注入完整名单。

## Capabilities

### New Capabilities

- `session-agent-roster`：会话级可用智能体的创建、命名、持久化、按名称派遣与状态投影。

### Modified Capabilities

- `worker-dispatch`：新增“可用智能体绑定派遣”要求（ADED，不改动既有名称路由与模糊匹配要求）。
- `worker-management`：新增“执行次数”要求（ADDED，不改动既有删除、恢复与重命名要求）。

## Impact

- Host：`src/host/storage.ts` 新增按会话持久化的 roster 存储；`src/host/index.ts` 增加 roster Remote、派遣绑定、状态投影与提示词分段；`src/host/runtime.ts` 在每轮开始时累加执行次数。
- Client：面板顶部新增「可用智能体」区域（本次变更内实现），复用现有设置页样式与主题 token。
- 数据：新增 `roster-<会话哈希>.json`；`Worker` 增加可选 `runCount`，旧记录缺省按 0 读取，不需要迁移。
- 兼容：没有可用智能体时会话行为与现在完全一致；可用智能体名称只在本会话内生效；不外发到其他会话，不写远端。
- 不新增 CLI 探测、账号读取或模型猜测；派遣仍走既有 `querySelection` 校验，校验失败明确报错。
