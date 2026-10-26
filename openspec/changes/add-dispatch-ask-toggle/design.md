# Design

## “默认模型设置”对应哪项配置

插件里与派遣相关的设定有三处，均为 Host 私有存储：

| 存储 | 作用域 | 内容 | 写入来源 |
| --- | --- | --- | --- |
| `<projectKey>.preference.json` | 项目 + CLI | `model`、`effort`，以及 `dispatchRole`、`dispatchBinding` | 设置页 `configure()` 只写模型/强度并保留原角色与绑定；完整选型 `setDispatchSetup()` 写全部 |
| `<conversationKey>.conversation-setup.json` | 主对话 + 项目 + CLI | 已确认的完整设定 | 每次派遣成功 |
| 无全局或每 CLI 的跨项目默认值 | — | — | — |

设置页「项目默认设置」显示和修改的就是第一项。`storage.dispatchSetup(project, cli)` 读取同一文件，只有 `dispatchRole` 与 `dispatchBinding` 都存在时才返回完整设定，这也是现有“沿用设定”问题卡展示的内容。因此“设置里已配置的默认模型设置”取 **项目 + CLI 的完整设定**：模型、强度来自设置页（或上次选型），角色与账号绑定来自上次完整选型。设置页没有默认角色控件；缺少角色时不猜测“无角色”，回退到完整选型，保存后后续即可免询问。

## 开关作用域与存储

开关按 **项目 + CLI** 保存，与它依赖的默认设定作用域一致，也与“运行中发送”相同。关闭一个项目的询问不会让另一个项目在默认设定可能过期或未经核对时自动启动。

记录 `<projectKey>.dispatch-ask.json`：`{ policy: 1, project, cli, ask }`，strict schema；`atomicJSON` 写入（目录 0700、文件 0600）。读取复用“运行中发送”的安全读取（拒绝符号链接、硬链接和超大文件）。文件不存在即 `ask: true`，旧版本无需迁移。不放入 `preference.json`，因为 `setDispatchSetup()` 会整体重写该文件。

## Host 流程

`chooseDispatch` 在取得目录和当前账号绑定后读取开关：

1. 主对话已确认设定有效 → 照旧直接使用。
2. 主对话无设定：开启询问 → 原有“沿用”问题卡；关闭询问 → 项目完整设定 `valid()` 通过则直接使用，否则进入完整选型。
3. 主对话设定已失效：关闭询问且项目设定有效 → 使用项目设定；否则完整选型。
4. 任何来源的设定都继续经过 `querySelection`（`authorizeSelection`）、`assertExecution`、CLI 开关与项目一致性检查，失败时抛出错误且不启动。

`valid()` 仍要求 CLI、账号绑定一致，模型在当前目录且强度受支持。并发等待、取消和 `pending` 计数逻辑不变。

## Client

`DispatchAskRow`（`src/client/dispatch-ask-settings.tsx`）放在「项目默认设置」表单的“思考强度”之后，使用 `cwn-setting-row` 横向布局：左侧“调用前询问模型”标签与说明，右侧原生 `Switch`。切换立即调用 `setDispatchAsk`，保存中禁用；失败恢复原值并在复用的反馈位显示短错误。按用户要求不显示“已保存”提示。CLI 关闭或读取中时禁用。

## 风险与回退

- 用户可能忘记已关闭询问：说明文字写明关闭后直接使用本项目的默认设定，打开开关即可恢复。
- 回退：删除 `dispatch-ask.json` 或打开开关即恢复原行为；旧版本插件忽略该文件。
