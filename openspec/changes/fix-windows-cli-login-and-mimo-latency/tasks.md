# Tasks

## 1. Windows 入口与版本

- [x] 1.1 支持核验过的 Pi/OpenCode Windows 官方固定入口，补正反例测试，真实 Windows resolveNativeEntry 成功且注入/伪身份拒绝。
- [x] 1.2 核验 Pi1.1.0 SDK/RPC和原生菜单契约后更新支持版本与对应文档；离线探针和版本拒绝测试通过。

## 2. 账号终端

- [x] 2.1 统一外层/内部关闭等待和失败重试，安全保留终端身份；UI/Host生命周期测试覆盖清理失败和再次关闭。
- [x] 2.2 修复Windows实际终端进程回收及OMP立即退出原因，原生PTY开启/关闭和后代退出检查通过；无法修复的原生限制明确记录。
- [x] 2.3 按ZCode实际help修复登录/管理能力、Windows资源路径与安全诊断，定向测试和实际终端验证通过，同步说明。
- [x] 2.4 增强账号终端光标与焦点可见性，在Windows真实登录终端复验粘贴输入位置。

## 3. OAuth 目录

- [ ] 3.1 核查Claude/Kimi当前原生OAuth身份/目录/执行证据并修复可证实的不一致，测试覆盖同源/换号/退出及无可核验目录的明确短错误。
- [x] 3.2 完整复测Antigravity原生登录完成与状态刷新，修复已证实问题，保留需要用户授权及额度阻塞的真实边界。
- [ ] 3.3 按用户要求实现Claude代理可达时使用代理、关闭时使用原生login；临时覆写不修改用户配置，来源固定及认证失败不换号回归通过，真实登录复验。

## 4. MiMo 性能

- [x] 4.1 实现仅非秘密能力元数据的有界复用，热读不重复启动CLI，账号/配置/入口变化、取消及权限撤销测试通过。
- [x] 4.2 Windows同环境记录冷/热元数据与派遣耗时对比，区分插件前置和服务端响应，同步README及设计记录。

## 5. 集成交付

- [x] 5.1 类型检查、相关及完整回归、隔离preview构建和Windows定向测试通过，严格规格校验通过。
- [ ] 5.2 无活动任务时更新Windows实际Desktop，复验修复过的登录/目录/真实MiMo任务、续聊和停止，清理临时通道并保留证据。
- [ ] 5.3 将实际修复/性能对比/未验证边界写入doc/tasks.md和验收报告，核对规格与结果后阶段提交，不推送。

## 6. 实际派遣名称解析

- [x] 6.1 修复 CLI Worker/cliworker_start 入口说明、同名括号别名及同 CLI 重复指令的误判；本轮准入消息、不同 CLI 冲突、未知名称、引用/讨论/否定及工具必填参数的定向回归通过，类型及严格规格检查通过。
- [x] 6.2 集成后在 Windows Desktop 复验已授权 Antigravity 派遣句进入原生选型/任务流程，保留实际事件与测试产物证据。

6.1 自动验证（2026-10-11）：`pnpm --config.verifyDepsBeforeRun=false exec vitest run tests/routing.test.ts tests/dispatch-flow.test.ts tests/role-dispatch.test.ts` 为 3 文件 81 项通过；同参数 `typecheck`、本 change 严格校验和范围内 `git diff --check` 通过。后续实际 Windows Desktop 已完成6.2：同名括号别名派遣成功，Gemini 3.8 Flash Low 任务返回 SUCCESS/completed，文件独立核验通过。原生 rc.2 AgentLoop.preStep 从当前 `inbox.claim` 形成已准入消息；实际第二条验收句的误判来自末句工具参数说明被当成第二个未知 selector，不是读取历史。

## Workflow follow-up

- 只有所有业务验收完成才归档；若授权或原生能力阻塞，保留待办与证据，不以校验通过冒充完成。
