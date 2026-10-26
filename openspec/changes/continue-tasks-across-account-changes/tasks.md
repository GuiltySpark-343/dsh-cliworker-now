## 0. 真实账号实验（需用户授权真实模型调用及每个 CLI 的第二个账号）

- [ ] 0.1 各 CLI：账号 A 建立会话并完成一轮，切换到账号 B（或同账号新格式），用原生续接参数续一轮；记录退出状态、事件时序与是否被服务端接受。
- [ ] 0.2 Claude 补测原生登录与自身 API 网关路由之间的切换；Codex 补测含推理内容的会话。
- [ ] 0.3 按结果填写 `cross-account-resume.ts` 方式表，记入 `doc/tasks.md`；未测的 CLI 保持 `'try'`。

## 1. Host 改绑

- [x] 1.1 准备阶段：绑定变化时以当前绑定授权原模型与强度，通过后启动前追加改绑诊断说明并写入新绑定；无账号或授权失败按原逻辑拒绝；以旧账号受理的排队续聊在授权报账号已变更时重读一次当前账号。
- [x] 1.2 排队续聊出队、分支、子对话换模型及旧记录续聊走同一改绑路径（Host `launch` 续聊不传旧绑定；子对话目录与改选在保存目录未命中时读当前账号）；查看目录不写绑定。
- [x] 1.3 运行中引导遇到绑定变化时转为排队，Host 回执附 `queued`，Client 按排队项显示。
- [x] 1.4 保留同一次启动内的 A→B→A 快照核对。

## 2. 续接方式与改接

- [x] 2.1 新增 `cross-account-resume.ts`：方式表（全部 `try`）及不读内容的本地预检；目前只实现可确定的 Hermes oneshot `HERMES_HOME/state.db` 缺失判定，Codex rollout、Claude 项目会话文件的预检未做（路径规则未核实，误判会造成不必要的改接）。
- [x] 2.2 失败分类：改绑的续接轮次已启动进程、无任何 assistant/reasoning/tool 事件且非成功结束、非用户停止或清理失败时，判为续接前失败；最多改接一次。
- [x] 2.3 新增 `carryover-context.ts`：确定性摘录、预算与省略标注、单条截断、起止标记中和。
- [x] 2.4 改接：新原生会话、沿用模式/角色/模型/强度、替换 `conversationId` 并保留 `previousConversationIds`、追加诊断说明；改接也未建会话时恢复原 ID。
- [ ] 2.5 上下文用量统计随改接重置（未做）；分支的原生分支操作失败时改接（未做，分支仅取消账号拦截，由子任务首轮改绑）。

## 3. Client

- [x] 3.1 过程区显示改绑与改接说明（`diagnostic`，详情经 `hostText` 翻译）；引导转排队按排队项显示；多语言词条。
- [x] 3.2 快照不再给出旧记录拦截原因（`resumeBlockedReason` 不再由旧记录产生；当前无账号在发送时报登录错误）。

## 4. 自动检查

- [x] 4.1 改绑：换号续聊自动继续且无提示；无账号拒绝；新账号模型不可用拒绝且不启动；新任务排队换号仍拒绝；A→B→A 竞态仍拒绝；旧记录改绑（`tests/cross-account-continuation.test.ts`、`tests/runtime-account-isolation.test.ts`）。
- [x] 4.2 排队续聊以旧账号受理后按新账号授权；子对话目录与改选读当前账号且不改绑（`tests/cli-settings.test.ts`、`tests/worker-management.test.ts`）；运行中消息转排队、本轮进程未收到（`tests/followup-queue.test.ts`）；Client 排队回执（`tests/panel.test.tsx`）。分支改绑无单独用例。
- [x] 4.3 改接：续接前失败触发一次改接；改接失败恢复原 ID；有回复或工具事件后失败不改接；用户停止不改接；同账号失败不改接；方式表 `'carryover'` 与预检不可达直接改接、未启动原生续接。
- [x] 4.4 摘录：预算省略标注、保留首轮需求与最近完整轮次、不含工具输入输出、单条截断、起止标记中和（`tests/carryover-context.test.ts`）。
- [x] 4.5 全量测试、类型检查、`build-preview.mjs`、OpenSpec 严格校验。

## 5. 文档与真实验收

- [x] 5.1 README、`doc/usage-details.md` 与 `doc/design.md`：换号续接行为、隐私说明、仍会拦截的情形。
- [ ] 5.2 Desktop 实测（需用户授权）：至少一个可原生续接的 CLI 与一个改接的 CLI，各完成换号后续聊，核对事件、退出状态、时间线说明与实际产物。
