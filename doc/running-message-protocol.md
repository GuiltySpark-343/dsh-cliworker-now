# 运行中发送的原生依据

本页记录 v0.7.9 在 2026-10-15 核对的引导协议。插件只为 Pi 和 OMP 接入运行中引导，其他 CLI 的当前启动通路不据此宣称支持。引导使用当前进程、模型及会话，不新建轮次；原生接收回执表示 CLI 已接收消息，不代表模型已执行。

## Pi

- [官方 RPC 命令](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md#steer)定义 `{id,type:"steer",message}`，响应重复请求 id，包含 `command:"steer"` 和 `success`。本次同时核对本机官方 1.0.2、1.0.4 包中的同名文档，以及 1.0.4 的 `dist/modes/rpc/rpc-mode.js` 与 `dist/core/agent-session.js`。
- 新版成功响应可能携带 `data.disposition:"queued"` 或 `"handled"`；前者代表进入原生引导队列，后者代表输入处理器已接手，均不能解释为模型已经完成。
- 文档规定引导在当前 assistant 的工具调用结束后、下一次模型调用前生效，并不保证打断正在输出的内容。纯 `steer` 在空闲状态不会自动创建新一轮，插件只在本轮尚未收到终止事件时发送。
- [官方 RPC 生命周期](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#run-lifecycle)区分 `agent_end` 和 `agent_settled`；插件沿用后者作为终止信号，并在退出前复核原生状态。

## OMP

- 本机直接读取的 CLI 版本为 `omp/16.4.4`。核对[该版本官方 RPC 实现](https://github.com/can1357/oh-my-pi/blob/v16.4.4/packages/coding-agent/src/modes/rpc/rpc-mode.ts)，`steer` 分支调用 `session.steer(command.message,command.images)`，完成后返回匹配 id 的 `command:"steer",success:true`；失败返回 `success:false`。
- 不依赖新版才有的额外控制命令，不要求成功回执含 Pi 的 disposition 字段。本机另一个 Bun 包版本更高，其源码仅作为补充交叉检查，不作为 16.4.4 的能力证明。
- 插件沿用已接入的终止 `agent_end` 判断与最后 `get_state` 校验；本次没有迁移到新版 OMP 的其他生命周期协议。

## 插件通路与边界

当前 Host 保持原有进程树管理，未开放通用 stdin、终端按键或 shell。每次准备执行时，在该次私有请求目录建立独立控制邮箱：目录 0700、文件 0600，随机运行凭证、请求 id 摘要及文本长度限制；只接受 `steer`。读取拒绝符号链接、硬链接、越界长度及读取期间变化；目录身份变化后拒绝操作。

Host 对重复请求复用原结果；同一 id 对应不同文本会被拒绝。明确未准备且未投递、或原生返回 `success:false` 时，以 `STEER_REJECTED` 标识确定未接收，允许用户重试；每次尝试使用独立文件名和原生请求 id，最多三次。成功与未知结果不会重投，每轮最多 200 条不同消息。

桥将请求关联至唯一原生 id，只在明确匹配的成功回执后确认接收。原生拒绝只影响该条引导，不改变原任务的正常完成结果。先观察到终止再收到回执时，不报告引导接收成功；所有未决回执结束后才进行最终状态校验。已发布的匹配回执优先于停止等待信号，关闭通路会先等 Host 读完已发布回执再清理邮箱，避免成功接收被退出竞态覆盖。原生异常退出或停止会拒绝未决请求，结束后关闭控制通路。超时或连接中断不自动改为排队、插队或重投。

桥不转发原生 user 消息，已确认的引导用户消息由 Host 统一追加，避免重复；原生的后续 assistant、公开过程与工具记录继续沿现有协议展示。

## 本轮验证

受限邮箱测试使用模拟处理器，验证成功回执、重复请求只投递一次、拒绝后可继续、关闭、取消、超时、错误凭证、非 steer 命令及链接文件拒绝。原生桥测试使用明确标注的模拟 Pi/OMP RPC 进程，验证两种成功响应、相同进程/会话、重复投递、原生拒绝、终止先于回执及异常退出；不调用真实账号或模型。

真实模型执行、Windows 实机及已安装 Desktop 不由这些模拟结果替代。具体运行结果与集成验收记录于 `doc/tasks.md`。


### 已安装 Desktop 补验（2026-10-15）

用户授权后，在 macOS 已安装 Desktop 使用保存的 Pi GLM-5.3 / Low 完成一次真实引导。消息在当前输出期间获得接收确认，原生会话中也存在该消息；插件 runId、原生会话和连接保持不变。Pi 完成当前输出后，在同轮下一条 assistant 回复中执行引导，回复 `PI_STEER_OK`；这不代表即时截断当前生成。无工具调用，Host 完成且待发送为空。

同轮 Codex 验证了正常完成后自动排队发送、卡片插队先停止再发送，以及其余队列顺序保留。OMP 本轮仅确认实际设置页默认引导，没有进行真实模型引导；Windows 未复验。前两次 Pi 尝试在引导发送前结束，不计入原生引导通过。详细证据边界见 `doc/tasks.md` 的 Desktop 最小验收记录。
