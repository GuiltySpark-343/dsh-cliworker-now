# 实施任务与验证记录

## 阶段 1：基础准备
- [x] 核验 Harness 0.2.0-rc.2、agy 1.2.16 和真实模型列表（规划阶段只读核验）。
- [x] 建立 AGENTS.md、设计文档和任务清单。
- [x] 初始化 main、提交基础文档、建立 feat/antigravity-mvp。
- [x] 建立锁定依赖及构建脚本。

## 阶段 2：原生接入
- [x] 独立 bundle 可安装、加载、卸载。
- [x] 原生右侧栏与 Host/Client RPC 可用。

## 阶段 3：执行闭环
- [x] 项目级模型选择与继承。
- [x] 流式解析、持久化、并发与会话互斥。
- [x] 停止、续聊、失败与中断恢复。
- [x] 后台完成结果回传父 Agent。

## 阶段 4：体验整合
- [x] 明确调用意图路由及四个模型工具。
- [x] 两层任务树、状态、模型标签、实时记录。
- [x] 明暗主题、窄侧栏、长路径与工具日志展示；滚动位置按贴底状态保持。

## 阶段 5：交付验证
- [x] 类型检查、测试、构建。
- [x] 隔离 Harness profile 集成验收。
- [x] 真实 Antigravity 运行、停止和续聊。
- [x] 安装到本机 Desktop profile 并验证。
- [x] README 安装、使用和卸载说明。

## 实际验证记录

2026-10-04：

- Git：`main` 基础提交 `51e08e0`；开发分支 `feat/antigravity-mvp`；本地身份 SuperWheel，无远程。
- 使用官方 0.2.0-rc.2 包与 Typert 生成器构建，Host/Client 类型检查通过。
- `vitest` 20 项通过：UTF-8 任意分片、畸形与超长输出、会话 ID 冲突、重复最终事件、未知事件、私有权限、锁与崩溃恢复、项目配置隔离、调度、并发互斥、排队取消、停止、认证/非零退出/缺结果、超时与输出限制。
- 真实 smoke：`gemini-3.8-flash-low / low`；首次读取随机 nonce 成功，同 conversation_id 续聊复述成功；另一个真实 CLI 在收到 init 后被停止，已 await 原生管理器的整个进程范围退出。证据 `.test-data/evidence/real-smoke.json`，原始记录留在 `.test-data/real-smoke/`，不入 Git。
- 隔离 profile：`.test-data/harness-home/profiles/cliworker-test`，官方 `dsh plugin add` 安装成功，宿主无插件激活告警，右侧栏及 Gateway 流可用。
- 原生模型问题卡片实际选择 `gemini-3.8-flash-low / low`；确认前没有 worker 进程，等待选择时终止宿主得到 ASK_ABORTED，未创建 worker。
- UI 测试父消息由明确标注的测试夹具创建。子 CLI 为真实调用，首轮返回 `CLIWORKER_UI_OK`；从侧栏续聊返回 `CLIWORKER_UI_OK FOLLOWUP_OK`。Harness Jobs 完成通知与父 Agent 总结实际出现。
- 随后在主对话实际输入“用 Antigravity CLI 新建另一个子 Agent…”，主 Agent 正确调用插件并沿用默认模型，无第二次选择；第二 worker 返回测试目录与 `SECOND_WORKER_OK`。任务树切换后记录互不混淆。
- 真实页面浅色、深色主题均已检查，约 360px 侧栏中模型标签、长路径和输入框可读。暗色截图 `.test-data/evidence/sidebar-dark.png`。

后续验证记录追加于此。

- 最终补充：原生 terminal 的 PID + 启动身份追踪，修复普通 pipe 进程组停止无法覆盖 CLI 工具另建进程组的问题。模拟 detached 子进程回归与真实 agy → Node 工具子进程回归均通过；真实 PID 36433 停止后返回 ESRCH，证据 `.test-data/evidence/real-stop-regression.json`。早期 shell/Python 夹具未产生 PID 标记，不计为通过。
- 增加最终聚合响应去重测试；20 项自动测试、构建、Host/Client 类型检查通过。
- 隔离 profile 官方 remove → add 成功。Desktop 原配置已私有备份，官方 add 完成；Desktop 插件页面显示 v0.1.0 已启用、1 个组件运行中，截图 `.test-data/evidence/desktop-installed.png`。Desktop profile 由 Electron 独占，CLI dump-config 不适用，改用原生插件管理页验收。
- 早期测试驱动手工写入的两份父会话日志不满足 Harness 回放契约；插件 worker 记录正常恢复。驱动已改为仅注册测试命令，不再写入任何父会话日志。旧夹具不计入完整恢复验收。

- 最终原生恢复验收：通过 Harness UI 全新创建会话“Antigravity CLI 恢复验证指令”，真实派遣得到 `NATIVE_RECOVERY_OK`。关闭并重启宿主，父历史正常回放、worker 记录恢复且无重复；侧栏续聊返回 `NATIVE_RECOVERY_OK RESUMED_OK`（页面恰有 1 条），证明保留原 CLI 上下文。截图 `.test-data/evidence/sidebar-recovered.png`。
- 界面显示来自 CLI 的原始公开粒度；不会承诺逐 token、未公开思维链或拦截任意外部 CLI。系统级双重 fork 后瞬时脱离祖先链等极端情况不在本轮验收覆盖内。

- 干净构建与打包通过；安装包 `artifacts/dsh-cliworker-now-0.1.0.tgz`，不包含测试夹具、凭据或运行数据。源码链接安装已完成，源码目录需保留原位。

## 阶段 6：体验与稳定性（v0.1.1）

用户选择优先完善体验与稳定性，继续保持 Antigravity 单 CLI、两层任务树。

- [x] 修复切换任务草稿丢失及异步操作结果串到其他任务的问题。
- [x] 断线保留记录、提供重新连接按钮；切换时不短暂展示其他任务的数据。
- [x] 保持历史阅读位置并提供回到最新消息入口。
- [x] 显示持久化错误和无法续聊原因；结束后不再把未完成工具显示为运行中。
- [x] UI 交互与宿主状态回归测试、原生侧栏验收、版本与文档同步。

### v0.1.1 实际验证（2026-10-04）

- 28 项测试通过（21 项 Host/协议/进程与 7 项 React 交互回归），Host/Client 类型检查通过。新增覆盖草稿隔离、延迟成功/失败归属、断线保留与重订阅去重、滚动位置、缺失会话 ID、父会话切换；恢复中断事件只追加一次。
- 完成结果改为独立快照，并验证续聊不改变已完成轮次的 runId/status/response。
- 在隔离 profile 安装预览包，已有 v0.1.0 历史正常读取。原生 UI 创建真实第二 worker“体验验收”，返回 `UI_STABILITY_OK`；两个 worker 的未发送草稿切换后分别保留。
- 真实 CLI 续聊生成 30 行记录，原生滚动至顶部出现“回到最新消息”；点击后距底部 0.5px。截图 `.test-data/evidence/sidebar-v0.1.1-history.png`。
- 观察到父 Agent 曾复述旧轮摘要，而侧栏实际内容正确。因此通知补充本轮任务/runId、续聊标签和读取当前结果的指引；不以模型自述作为验证依据。
- 自动重连失败入口使用受控断流的 React 测试验证；未以伪造数据充当真实 CLI 输出。

- 最终真实续聊返回 `V011_FOLLOWUP_OK`；磁盘状态 completed，runId `a8bc3b31-7b26-40a8-86ce-17b096efeac7`；父 Agent 实际引用了本轮结果与新运行编号。证据 `.test-data/evidence/v0.1.1-acceptance.json` 和 `sidebar-v0.1.1-final.png`。
- 正式干净构建、类型检查和 `pnpm pack` 通过，安装包 `artifacts/dsh-cliworker-now-0.1.1.tgz`。确认 Desktop 无活动 CLI worker 后更新链接包；原生插件页显示 v0.1.1 已启用、1 个组件运行中，截图 `desktop-v0.1.1-installed.png`。隔离验收服务器已停止。

## 阶段 7：历史浏览与任务查找（v0.1.2）

- [x] 原生分页读取已保存的完整逻辑记录，支持向前/向后翻页和返回实时。
- [x] 历史阅读期间保留当前位置，运行中的实时更新不覆盖历史页。
- [x] 按标题/模型/强度与状态筛选子 Agent，筛选不停止任务、不丢草稿。
- [x] 复制具体回复或本轮结果，明确成功/失败反馈。
- [x] 分页边界、身份隔离、并发新增事件及 UI 交互测试；隔离原生验收后升级 Desktop。

### v0.1.2 验证记录（2026-10-04）

- 35 项测试通过；新增覆盖 1,250 行记录完整回读、双向分页无重叠、实时追加不移动页边界、非法/跨任务游标、历史页对抗新快照与迟到请求、筛选保留选择和草稿、复制原文及拒绝写入的反馈。
- 隔离 profile 以 `maxTimelineItems: 10` 的仅测试 overlay 验收，使用已有真实 CLI 记录而非写入模拟对话；Desktop 正式默认仍为 1000。
- 原生侧栏中“体验验收”共 12 条逻辑记录：实时显示末 10 条，向前读取 1–2，向后读取 3–12，再返回实时。筛选标题及“进行中”状态符合预期，清除筛选后恢复列表。
- 点击复制最新结果显示成功；直接粘贴到未提交的输入框核对 `V011_FOLLOWUP_OK\n` 完全一致，随后清空，未派发新任务。浏览器自动化的虚拟剪贴板读接口返回空值，因此以真实 UI 粘贴验收为准。
- 隔离预览、正式构建、Host/Client 类型检查和打包通过；安装包 `artifacts/dsh-cliworker-now-0.1.2.tgz`。更新前确认 Desktop 无活动 worker，插件管理页已显示 v0.1.2 启用且 1 个组件运行中。
- 原生历史页截图 `sidebar-v0.1.2-history.png`、安装截图 `desktop-v0.1.2-installed.png` 和验收摘要 `v0.1.2-acceptance.json` 留在 `.test-data/evidence/`，不入 Git。隔离服务器与临时验收页面已关闭。本轮使用已有真实 CLI 记录验收，没有新增 CLI 推理调用。

## 阶段 8：多 CLI（v0.2.0）

- [x] 识别 CLI 与项目偏好隔离，兼容旧 Antigravity 数据。
- [x] Codex / Claude / Kimi / 官方 MiMo 的参数、协议和模型目录适配。
- [x] 侧栏 CLI 标识、独立默认设置与模型实际映射显示。
- [x] 模拟协议、配置隔离、能力限制与 UI 交互回归。
- [x] 隔离 Harness 原生界面验收、正式构建与 Desktop 更新。
- [ ] 四种新增 CLI 均完成真实首轮、续聊和停止验收。

### v0.2.0 验证记录（2026-10-04）

- 本机版本：Codex 0.160.0、Claude Code 2.1.176、Kimi Code 0.42.0。官方 MiMo 0.1.15 仅安装在项目缓存用于帮助与模型目录核验，不是全局安装或登录。
- 用户已选定真实验收配置：Codex gpt-6-luna / low，Claude sonnet / low，Kimi kimi-code/k3-256k / CLI 默认强度。
- Codex 与 Claude 的首轮随机标记回复及原会话续聊均通过，证据 `.test-data/evidence/multi-smoke.json`。Claude 本机 sonnet 别名实际映射为 glm-5.2[1M]；不能把本次成功表述为 Anthropic Sonnet 模型验收。
- Kimi 真实运行返回订阅访问权限 403、状态 failed；没有完成首轮或续聊，不重试消费，不修改订阅。
- MiMo 官方缓存 CLI --help 与模型目录解析通过（7 个模型）；没有执行真实推理，尚待安装/认证及用户模型选择。
- 模拟协议与回归测试目前 54 项通过；模拟数据不替代真实 CLI 验收。

- 用户随后安装官方 MiMo 0.1.15，路径 `~/.mimocode/bin/mimo`。插件识别官方用户目录安装位置，解决 Desktop 未加载 `.zshrc` 时找不到新命令的问题；该真实安装的模型目录已在原生侧栏读取。
- 最终 57 项测试通过，包含混合 CLI 同目录写任务排队、续聊不可换执行器、Kimi tool-only EOF 不误报成功、原生按钮提交类型与设置失败处理。Host/Client 类型检查、隔离构建、正式构建和 pack 通过。
- 原生 UI 暴露旧设置按钮默认为 type=button，已显式改成 submit；实际保存 Codex gpt-6-luna/low 后重新打开读取一致，磁盘偏好与旧 Antigravity 偏好分别存在。
- 原生混合任务树使用实际 smoke 的 worker/event 文件，导入到隔离 profile 的已存在父对话；标题明确“真实记录导入验收”，只调整插件测试数据中的父关联，未写入 Harness 主对话日志，不计为主 Agent 自然语言派遣的真实验收。
- 原生 UI 验证 Claude 实际模型、Kimi 默认强度与 403 错误、Codex/Kimi/MiMo 模型目录。截图 `.test-data/evidence/sidebar-v0.2.0-multi.png`。Desktop 无活动 worker 后更新，插件管理页显示 v0.2.0 已启用、1 个组件运行中。
- 安装包 `artifacts/dsh-cliworker-now-0.2.0.tgz`。Kimi 真实成功与续聊仍被账户权限阻止；MiMo 真实首轮和续聊已通过。各新增 CLI 的真实停止尚未分别验收，共享原生进程清理回归已通过。不可将这些未验收项写成已完成。

- MiMo 用户选定 `xiaomi/mimo-v2.5 / low` 后，真实随机标记首轮、同 sessionID 续聊均 completed 且回复匹配，证据 `.test-data/evidence/multi-smoke-mimo.json`；没有改为自动选模或其他模型。

- 最终原生页面展示六个直接 worker（含旧 Antigravity 与三种新增 CLI 的真实结果、Kimi 失败），MiMo 回复与模型/强度标签正确；Kimi 无会话 ID 时续聊禁用。最终截图 `sidebar-v0.2.0-mimo.png`、安装截图 `desktop-v0.2.0-installed.png`、验收摘要 `v0.2.0-acceptance.json` 均位于 `.test-data/evidence/`。隔离服务器在验收后关闭。

## CLI 卡片图标设计（2026-10-04）

- [x] 核验五类 CLI 的官方素材或本机官方应用图标。
- [x] 使用内置 image_gen 生成五组扁平图标，共六张 PNG（Kimi 分亮暗主题）。
- [x] 核查六张 PNG 均为 1254 × 1254 RGBA，四角完全透明；记录透明像素与主体边界。
- [x] 浏览器实看亮暗卡片中的 24px／32px 图标，保存 `doc/assets/cli-icons/v1/preview.png`。预览服务与临时页面已关闭。
- [x] 素材、来源说明、完整提示词和预览页保存到项目。
- [x] 图标已在 v0.3.0 接入正式父级页面并跟随 Harness 主题。

本轮没有修改业务代码或安装版本，没有调用真实 CLI，也没有重跑业务测试。验收范围为图标素材、透明通道和浏览器视觉展示。

### 项目独立图标（2026-10-04）

- 使用内置 image_gen 生成 CLI Worker Now 独立扁平图标，保存于 `doc/assets/project-icon/v1/`。
- 已目视检查图形，核查 PNG 的 RGBA 与四角透明；完整提示词和透明通道检查随素材保存。未接入运行界面，未运行业务测试。

### 项目图标第二轮（2026-10-04）

- 用户否定 v1 与 Codex 过于相似；已在素材说明中标记否定状态，保留历史文件。
- 使用内置 image_gen 新生成 A 会话气泡、B 任务分派、C Worker W 三张扁平透明 PNG，保存于 `doc/assets/project-icon/v2/`。完整提示词与 alpha 检查随素材保存。
- 已目视检查三张生成图并确认 RGBA 与四角透明；尚待用户选择，没有替换插件图标，没有进行业务代码变更或业务测试。

### 项目 Logo 会话可见方案（2026-10-04）

- [x] 根据项目的多 Agent 对话可视化特点，使用内置 image_gen 生成新设计稿 v3：打开的会话窗口、三条并列会话、实时状态圆点。
- [x] 原图、完整提示词、设计说明、HTML 预览和浏览器截图保存至 `doc/assets/project-icon/v3/`；未覆盖此前方案。
- [x] 检查 1254 × 1254 RGBA 原图的透明通道，并在浏览器实看亮暗背景及 24px／32px／48px 尺寸。
- [x] 用户已通过素材包选定 v3；v0.3.0 接入插件（此前设计稿阶段未修改业务代码）。

## 阶段 9：B 桌面侧栏设计（v0.3.0）

- [x] 父级按 CLI 分组卡片，子级独立对话与返回按钮；状态在话题后，元数据无“思考”前缀。
- [x] 桌面式消息与续聊框、子级标题去除模型/强度行；实际模型信息保留在任务选项。
- [x] 接入用户提供的七张透明原图，Kimi 随宿主主题切换。
- [x] 搜索、折叠、状态筛选、草稿、历史与停止交互回归。
- [x] 正式构建、打包、Desktop 更新；提交在本地开发分支，不推送远程。

### v0.3.0 实际验证（2026-10-04）

- 59 项测试通过（新增分组/折叠、两页导航、标题元数据与停止入口覆盖）；Host/Client 类型检查和隔离构建通过。
- 隔离 Harness 使用已保存的真实 CLI 记录验证五种 CLI 分组、搜索、返回保留草稿、异常筛选、历史 1–2/12 与返回实时；没有新增 CLI 推理调用，也不把导入记录当成本轮自然语言派遣证据。
- 亮暗主题在 Harness 原生设置内切换，七张 1254px 原图加载成功，Kimi 对应主题图片显示；约 365px 侧栏无横向溢出。
- 发现并修复屏幕阅读器隐藏标签导致的外层滚动溢出；输入框聚焦后标题仍位于侧栏顶部（y=38），长记录只在内部滚动。
- 页面证据保存在 `.test-data/evidence/sidebar-v0.3.0-*.png`，不入 Git。Kimi 原有账户 403 及新增 CLI 单独真实停止验收边界未改变。

- 最终隔离构建、正式构建、Host/Client 类型检查与 pack 通过。pnpm 11 在包版本变更后触发依赖自动重装检查，本轮依赖和锁文件未变，使用 `--config.verify-deps-before-run=false` 执行既有脚本，避免无关重装。
- 正式更新前确认 Desktop 状态目录无 worker 文件/活动任务；插件页刷新后显示 v0.3.0 已启用、1 个组件运行中。原生 Desktop 从侧栏引导打开新版总览空态成功；没有创建虚假任务。
- 安装包 `artifacts/dsh-cliworker-now-0.3.0.tgz`；安装与页面截图、验收摘要位于 `.test-data/evidence/`。隔离主题恢复原深色，验收服务器及临时页面已关闭。

## 阶段 10：原生控件与样式统一（v0.3.1）

- [x] 任务标题与元数据靠卡片左侧 12px 对齐，CLI 标题与任务列表添加分隔线。
- [x] 搜索直接使用原生 Input；筛选使用原生 Button 标准 36px 高度，不覆盖其字体和描边。
- [x] 自定义文字引用宿主字体尺度；对话与续聊响应原生字号设置；圆角、边框和阴影引用宿主参数。
- [x] 隔离亮暗主题/365px 侧栏验收，正式构建与 Desktop 更新，本地提交。

### v0.3.1 实际验证（2026-10-04）

- 16 项 React 页面回归通过；Host/Client 类型检查、隔离构建、正式构建与 pack 通过。本轮未重复运行未改动的 Host/CLI 进程测试，也未新增模型调用。
- 原生搜索输入“体验”仅显示对应任务，进入子页正常；365px 侧栏无横向溢出。标题与元数据实际左边距均为 12.5px（含半像素卡片边框）。亮色卡片和标题分隔线为 0.5px rgba(0,0,0,0.1)，暗色同样使用宿主语义色。
- 在隔离 Harness 设置将字号 14→15，插件正文与续聊框均实时变为 15px，恢复后均为 14px；恢复原深色主题。输入框圆角与主 composer 相同，读取宿主 panel=28px 与 elevation-soft 阴影。
- 更新前 Desktop 无活动 worker；插件管理页显示 v0.3.1 已启用、1 个组件运行中。返回主页面后新版总览正常，未创建模拟任务。隔离服务器和验收页面已关闭。
- 证据 `.test-data/evidence/sidebar-v0.3.1-light-overview.png`、`sidebar-v0.3.1-dark-overview.png`、`sidebar-v0.3.1-dark-conversation.png`、`desktop-v0.3.1-installed.png`；安装包 `artifacts/dsh-cliworker-now-0.3.1.tgz`。

## 阶段 11：消息与 composer 对齐（v0.3.2）

- [x] CLI 入口浅色扁平背景；原生设置、复制、发送图标；搜索框 38px 且移除聚焦蓝圈。
- [x] 原生安全 Markdown 回复，时间/复制操作置于消息下方，24 小时制时间。
- [x] 原生 composer 几何/发送按钮/底栏，取消拖高，内容自动增高。
- [x] 原生模型菜单与强度子菜单，严格区分当前会话固定配置和新任务默认配置。
- [x] 隔离及 Desktop 验收、构建打包和本地提交。

### v0.3.2 实际验证（2026-10-04）

- 17 项 React 交互回归通过；新增验证菜单只写项目/CLI 默认配置，不触发 followup、不更改当前 worker 模型。Host/Client 类型检查、隔离构建、正式构建和 pack 通过。
- 同一个隔离原生页面测量：主 composer 与插件空输入框都高 98px、圆角 28px；插件发送按钮高 34px，背景 rgb(65,118,230)。搜索框高 38px，focus 后 outline=none、shadow=none，描边为 0.5px rgba(0,0,0,0.12)，CLI 入口背景为白色。
- 四行未提交草稿令 textarea 自动变为 100px，resize=none，根侧栏 top 仍为 38px；清空恢复。子会话 Markdown、时间、复制按钮、模型菜单、CLI 真实模型与强度子菜单正常呈现；亮暗主题验收通过。
- 使用既有真实记录；没有新增推理调用，没有修改已保存模型偏好。隔离主题恢复深色，浏览器尺寸恢复，测试页面和服务器关闭。
- 正式更新前 Desktop 有 1 个历史 worker、0 个活动 worker。插件页显示 v0.3.2 已启用、1 个组件运行中；用户已有“说一句你好”对话实际加载新版时间/复制/模型菜单和 composer。
- 安装包 `artifacts/dsh-cliworker-now-0.3.2.tgz`。截图位于 `.test-data/evidence/`：`sidebar-v0.3.2-overview.png`、`sidebar-v0.3.2-conversation.png`、`sidebar-v0.3.2-model-menu.png`、`sidebar-v0.3.2-dark-conversation.png`、`desktop-v0.3.2-installed.png`、`desktop-v0.3.2-conversation.png`。

## v0.3.3 — 模型选择、真实耗时与 Desktop 404 修复（2026-10-05）

- [x] 根因复现：旧 Desktop Host 未重新加载新增 Remote 接口，Client 的 `catalogForCli` 返回 HTTP 404。完整退出并重新打开 v0.3.2 后，同一实际会话设置页恢复模型及强度；由此确认并更新安装说明，不能以插件页刷新/版本号作为接口验收。
- [x] 实际 `agy models` 核验：Flash 3.8/3.7/3.6 各 low/medium/high；Pro 3.1 仅 low/high；GPT-OSS 120B 仅 medium；Claude 型号未公开等级，保守沿用 CLI 配置。
- [x] 按真实目录合并家族名称、保留执行 ID 映射；支持旧 raw ID 偏好，禁止未知强度；默认设置和当前会话配置分别保存。
- [x] 新 `configureWorker`：校验归属、CLI、目录与空闲状态；更改下一轮型号/强度，保留会话 ID 和历史；运行中拒绝变更。
- [x] 模型菜单采用原生 Menu/Input 与 ModelSelect 的模型/强度两项入口；模型可检索。发送按钮采用原生 InputBar 的准确 SVG 路径与 34px 几何，不再使用不同的线条图标。
- [x] 基于完整事件的每轮耗时，分页后仍可展示；展开公开状态、工具及诊断，明确不补写未公开思考。原始 transport 报错改为可操作的中文提示与重试。
- [x] `pnpm test`：4 个文件、64 项通过，含真实子进程组清理。`pnpm build:preview`、`pnpm build`、`pnpm typecheck`、打包均成功。
- [x] 隔离真实 UI：模型菜单 7 个去重选项；切换 Pro 后只有 low/high；切换 Flash low→medium 持久化成功。真实续聊 run `5dd9bfa8-6ccf-48fb-b0a1-d2eb362ec5e4` 返回 `MODEL_SWITCH_OK`，状态 completed；原始 init 实际模型 `gemini-3.8-flash-medium`，conversation ID 仍为 `30229a34-d379-4b19-a844-fae0c0470a5b`。这是新真实请求，不是模拟记录。
- [x] 隔离暗色窄侧栏视觉核验：工作过程显示 13 秒、菜单等级与原生发送图形；证据 `.test-data/evidence/v0.3.3-pro-efforts-dark.png`。
- [x] 正式更新前确认 Desktop 活动 worker 为 0；已生成 `artifacts/dsh-cliworker-now-0.3.3.tgz`。
- [ ] 正式 Desktop 最终交互验收：更新后已执行正常退出，重新打开时 Mac 锁屏，等待用户解锁；不得将此阶段标为已验证。

### 项目 Logo Cli 字形修订（2026-10-05）

- [x] 内置 image_gen 按用户标注修改，原图与提示词保存至 `doc/assets/project-icon/v4/`，保留之前版本。
- [x] 目视检查 Cli 构形与内容移除，核验 PNG 的 RGBA、透明像素与四角透明；原样复制一份到本地素材包文件夹。
- 此次仅修改设计素材，未接入插件，未运行业务测试。

### 项目 Logo 紧凑等高版（2026-10-05）

- [x] 内置 image_gen 编辑 v4，统一 C 主体、l 与 i（含圆点）的上下边界，缩窄 C 与留白。
- [x] 目视检查形状，核验透明通道；原图、提示词和检查结果保存至 `doc/assets/project-icon/v5/`，另复制到本地素材文件夹。
- 本轮未修改业务代码或安装版本，未运行业务测试。

### 项目 Logo 柔和人文版（2026-10-05）

- [x] 用户认可 Cli 基本样式；使用内置 image_gen 优化曲线、比例和双蓝色，并再调整字母间隔以便缩小显示。
- [x] 原图、两步提示词和 alpha 检查保存至 `doc/assets/project-icon/v6/`；保留之前版本。
- [x] 浏览器实看亮暗背景中的 24／32／48px，保存 HTML 与截图。24px 可辨识，推荐标题旁采用 32px 以更清楚呈现间距与尾部。
- 本轮为设计素材迭代，未接入插件，未运行业务测试。

## v0.3.4 — 菜单返回与按钮悬停（2026-10-05）

- [x] 模型及强度子菜单共用顶部返回项；按钮去除静态描边，使用宿主主题色与 180ms 颜色过渡，保留键盘焦点及减少动画偏好。
- [x] 类型检查、18 项 React 界面测试、隔离构建、正式构建及打包通过；安装包 `artifacts/dsh-cliworker-now-0.3.4.tgz`。
- [x] 隔离暗色页面验证模型目录、顶部返回及强度选项；实测按钮 border 为 0px、transition 为 0.18s。截图 `.test-data/evidence/v0.3.4-effort-preview.png`。
- [x] 正式更新前活动 worker 为 0；Desktop 热加载后实际打开模型和强度菜单，均显示顶部返回、真实目录与 low/medium/high，无 404。截图 `.test-data/evidence/v0.3.4-desktop-model.png`、`v0.3.4-desktop-effort.png`。
- 本轮没有新增 CLI 推理或修改会话模型配置。此前锁屏造成的 Desktop 菜单验收阻碍已解除；本轮验证范围为菜单交互和外观。
- 已关闭本轮隔离浏览器页面及测试服务器，保留 Desktop。

### 项目 Logo 近正方形版（2026-10-05）

- [x] 内置 image_gen 在 v6 基础上调整纵向比例，保留原有设计语言。
- [x] 第一轮主体宽高比 1.382:1，继续修订后实测约 1.004:1；验证透明通道，原图与两步提示词保存至 `doc/assets/project-icon/v7/`。
- 此轮仅交付设计素材，未接入插件，未运行业务测试。

### 项目 Logo 舒展比例版（2026-10-05）

- [x] 根据用户要求放宽整体比例，使用内置 image_gen 从 v7 调整；两步提示词和透明原图保存至 `doc/assets/project-icon/v8/`。
- [x] 第一轮实际约 1.499:1，进一步调整后约 1.379:1；按实际测量记录比例，不将提示词目标当作结果。
- [x] 浏览器查看亮暗背景与 24／32／48px 效果，图片等比显示，保存预览页与截图。
- 仅更新设计素材，保留历史版本；未修改业务代码、安装版本或运行业务测试。

## v0.3.5 — 回复与底栏真实用量（2026-10-05）

- [x] 回复栏增加真实 Token 用量与原生日历格式；输入框底栏按左侧状态、中间 Token、右侧上下文圆环排列，复用原生数据库/仪表图标与 13px 次级字号。
- [x] 从私有原始日志只读增量恢复旧记录，区分回复、任务与 CLI 会话统计口径；同一快照不重复计数、历史分页不影响当前底栏；无记录时显示 `—`。
- [x] Antigravity 实际输出只有用量、没有当前上下文占用/容量；显示未知值和解释，不以累计用量生成虚假百分比。
- [x] 灰色/禁用按钮及 summary 增加平滑 hover，保留 disabled 操作限制与减少动画偏好。
- [x] 类型检查通过；全套 5 文件 72 项测试通过（首次沙箱内的进程清理测试被 ps 权限阻止，在批准的执行环境中重跑全套通过）。之后日期/读数边界微调，26 项相关回归与类型检查再次通过。
- [x] 隔离构建及暗色窄侧栏检查通过：旧 Antigravity 两次回复分别 21.5K、5.4K tok，底栏会话累计 26.9K tok；三项底栏同为 y=951、13px 字号。按钮 border=0px，transition=0.18s。截图 `.test-data/evidence/v0.3.5-preview-usage.png`。
- [x] 正式更新前活动 worker 为 0，构建、打包后完整重启 Desktop。原有“说一句你好”回复真实用量 20851 tokens 显示为 20.9K tok，日期显示 10月4日 22:19，底栏同样显示 20.9K tok。截图 `.test-data/evidence/v0.3.5-desktop-usage.png`。
- [x] 安装包 `artifacts/dsh-cliworker-now-0.3.5.tgz`；关闭隔离页面与服务器。本轮未新增 CLI 推理、未修改用户会话或偏好。


## v0.3.6 — 原生交互与上下文占用（2026-10-05）

- [x] 分隔线改用 Harness WorkStatus 的 border-l2。隔离暗色界面实测原生与插件均为 0.5px solid rgba(255,255,255,0.12)，高度 33px、100ms 颜色过渡。复制按钮均为 28px、8px 圆角，使用原生 Tooltip；菜单复用原生 Menu、原生箭头/选中图标及对应尺寸。
- [x] 回复与底栏的用量改为可点击详情，上下文使用原生定位/外部点击关闭能力、264px 详情面板；隔离验收确认 Esc 和点击外部关闭，两级菜单返回均在顶部。底栏状态恢复彩色圆点。
- [x] CLI 1.2.16 的模型目录和流式输出缺少上下文容量；核验其嵌入 protobuf 描述和插件所管理会话的 SQLite 元数据，增加只读可选适配。真实“说一句你好”读数为 28,757 / 256,000，显示 11%，明确为最近一次请求的 CLI 估算。
- [x] 新增 5 项模拟 protobuf/SQLite 测试：字段解析、非法值与未知字段、只读不修改数据库、归属与路径校验、最新元数据与缓存失效。类型检查及 6 文件 77 项测试通过；首次普通沙箱测试的 ps EPERM 在获准的执行环境中重跑通过。
- [x] 隔离构建、暗色界面验收、正式构建和打包通过。更新前 Desktop 活动 worker 为 0；完整重启后，在真实 Desktop 会话打开上下文详情并核验数值、日期、Token 与绿色圆点。最后修复无用量日志时仍可提供上下文，类型检查、77 项测试及两种构建再次通过。
- [x] 截图：.test-data/evidence/v0.3.6-preview-menu.png、v0.3.6-preview-context.png、v0.3.6-desktop-context.png。安装包 artifacts/dsh-cliworker-now-0.3.6.tgz。
- 本轮没有新建 CLI 推理、改动会话模型偏好或修改原始 Antigravity 数据库。主题和原生组件仍以 Harness 0.2.0-rc.2 为适配基线；CLI 未提供有效上下文时保留未知值，不承诺所有 CLI 都有该数值。

## v0.3.7 — 暗色卡片、悬停反馈与 v8 Logo（2026-10-05）

- [x] 暗色分组卡片与未选中筛选按钮共用 interactive-bg-hover；隔离界面实测两者均为 rgba(255,255,255,0.08)，取代过亮的 elevated-fill。
- [x] 顶部入口移至原生 header.utilities 尾部，移除 CLI 文字及计数，仅保留 Logo、无障碍名称与原生 Tooltip；Desktop 实际点击入口正常。
- [x] 项目入口、侧栏标题、空状态使用 v8 透明原图，SHA-256 与设计源文件一致，object-fit:contain 保持比例；侧栏图标槽实测 32 × 32px。各 CLI 品牌图标不变。
- [x] 恢复灰色按钮 180ms ease 的背景色、字体颜色及透明度过渡；实际 DOM 计算样式确认生效；禁用控件保留 disabled，减少动态效果设置保留。
- [x] 类型检查、18 项 React 界面回归、隔离及正式构建、打包通过。更新前活动 worker 为 0；Desktop 自动加载新 Client，实看亮色布局与右侧图标入口。
- [x] 验收截图：.test-data/evidence/v0.3.7-preview-dark.png、v0.3.7-desktop-light.png；安装包 artifacts/dsh-cliworker-now-0.3.7.tgz。
- 本轮仅界面/资源变化，没有启动新的 CLI 推理或修改用户会话配置；关闭隔离页面与测试服务，保留 Desktop。

## v0.3.8 — 白天灰色按钮悬停修复（2026-10-05）

- [x] 定位：亮色默认灰底与 hover-solid 视觉近似，只有 transition 并不能产生可见变化。亮色灰色筛选按钮、返回及禁用灰色控件悬停改用原生 interactive-bg-active，保留 180ms ease 和减少动态效果偏好；不改变暗色与已选筛选按钮。
- [x] 隔离构建后切到浅色实际验证：未选中“进行中”按钮 aria-pressed=false，默认 rgba(38,49,72,0.06)，真实 :hover=true 时最终为 rgba(38,49,72,0.1)，捕获到动画中间色，transition 为 0.18s。截图 .test-data/evidence/v0.3.8-light-hover.png。
- [x] 本轮仅 CSS 与版本文档变化，未新增或重复业务测试。隔离及正式构建、打包通过；更新前活动 worker 为 0。安装包 artifacts/dsh-cliworker-now-0.3.8.tgz。

### 项目 Logo 饱满对话版（2026-10-05）

- [x] 使用内置 image_gen 编辑 v8：放大对话尾部、明显缩小 C 留白并调整字母比例。
- [x] 目视检查变化并核验 RGBA、透明通道和复制一致性；原图与提示词保存至 `doc/assets/project-icon/v9/`。
- 本轮仅交付设计素材，未接入插件，未重新进行浏览器小尺寸验收或运行业务测试。

### 项目 Logo 收窄协调版（2026-10-05）

- [x] 内置 image_gen 调整 C 占比和字母比例，保存 `doc/assets/project-icon/v10/`；按用户要求不另存或展示提示词。
- [x] 目视检查形状，核验透明通道；未接入插件，未运行业务测试。

### 选定 Logo 与整体效果图（2026-10-05）

- [x] 用户选定 v10 Logo；设计记录已同步。
- [x] 内置 image_gen 制作四栏整体概念图，包含父子页面与亮暗主题，已目视检查并保存至 `doc/assets/overall-preview/logo-v10/overview.png`。
- 本轮未修改业务代码或安装版本，图中对话与状态均为示例。

## v0.4.0 — 原生设置弹窗、账号管理与局部加载（2026-10-05）

- [x] 工具栏入口使用原生 utilities、order=-20，位于 Finder(-10) 左侧；24px 小按钮、16px Logo。隔离 DOM 实测入口24×24px，Finder含外框高24px。取消侧栏标题下分隔线。
- [x] 设置复用 Harness Modal/Menu/Button/StateDot，5个CLI导航、账号区、项目默认区，继承亮暗主题。目录、账号、保存分别异步加载；切CLI/关闭取消并隔离迟到响应，不再使用Panel全局busy锁。
- [x] 账号管理使用经过本机核验的各CLI原生参数与PTY，安全状态摘要、登录/切换/退出入口；AGY与Kimi部分操作由用户在TUI输入原生斜杠命令。账号操作与同CLI任务互斥；主会话/插件关闭、中途取消和断流清理；超时和有界内存，无账号日志持久化。
- [x] 119项测试通过（9文件）：25项账号后端、7项账号终端、7项设置、19项Panel及原有协议/进程测试。覆盖跨父会话隔离、启动竞争、关闭与迟到启动、旧CLI响应、真实进程组清理和未确认清理后阻止改账号。初次普通沙箱ps被拒绝，使用获准环境运行完整测试通过。
- [x] 类型检查、隔离构建、正式构建及打包通过。完整更新前确认Desktop活动Worker为0；Desktop重启后实际点击设置，Codex真实状态显示“已通过ChatGPT登录”，模型和强度可选择，无404。
- [x] 隔离界面真实只读验证Codex、Claude、Kimi、MiMo状态；未知/配置存在与已认证严格区分。模型原生菜单、加载圆圈、切CLI、关闭、亮暗主题可用。
- [x] 独立模拟CLI真实PTY验收：界面明确显示“模拟账号终端”，输入ping收到ECHO: ping；关闭终端以及关闭设置两种路径后检查PID均不存在。深色终端跟随主题；修复亮色viewport黑底条。未运行真实登录/退出、未改用户账号或模型默认值。
- [x] 截图 .test-data/evidence/v0.4.0-settings-light.png、v0.4.0-settings-dark.png、v0.4.0-account-terminal-dark-fixture.png、v0.4.0-desktop-settings.png；安装包 artifacts/dsh-cliworker-now-0.4.0.tgz。隔离测试服务器和页面已关闭。


## v0.4.1 — 独立 CLI 开关与稳定设置页面（2026-10-05）

- [x] 每个 CLI 使用 Harness 原生 Switch 独立持久化；关闭后灰化，本次不移动，重新打开/页面刷新后稳定排到末尾。内容顶部始终显示该 CLI 图标与名称。
- [x] 已登录绿色、明确失败红色、未核验灰色；模型目录失败单独记录，不再混成“尚未检测”。不把本地凭据当作认证成功。
- [x] 固定弹窗高度700px并受原生最大可用高度限制，右侧独立滚动；账号摘要/按钮/选择器/说明预留固定空间，spinner位于标题固定槽。控件加载前后DOM和实际坐标不变。
- [x] 原生md按钮统一36px；原生Switch保持36×20px；下拉框及展开菜单实测300px。修复通用hover选择器覆盖active底色的问题，灰按钮实测静态rgba(38,49,72,0.06)，真实hover rgba(38,49,72,0.1)，180ms过渡保留。
- [x] Host在异步选择前后及最终提交校验开关；禁用后不能派遣/续聊/查询目录/探测账号/修改配置/开启账号终端。运行或排队任务与账号终端阻止关闭；历史/任务状态/停止保留。取消信号在读写开关前检查。
- [x] 142项测试通过（10文件），含10项开关持久/竞争/取消约束、20项设置状态和加载布局、19项Panel、25项账号管理及原进程/协议测试。Host+Client类型检查、隔离构建、正式构建、pack均通过。
- [x] 隔离原生Harness真实UI验收：加载前后modal700px、账号按钮/模型选择器/保存按钮位置完全相同；Codex单独关闭后灰化且原位，重开排末，恢复开启成功；亮暗主题、真实目录与账号状态可读。测试开关已恢复全开；未执行登录/退出或修改模型默认值。
- [x] 更新前确认Desktop活动worker为0；重启后实际打开新设置页，开关和模型查询可用，无新增RPC404。证据见 .test-data/evidence/v0.4.1-settings-light.png、v0.4.1-settings-dark.png、v0.4.1-settings-disabled-dark.png、v0.4.1-desktop-settings.png。安装包 artifacts/dsh-cliworker-now-0.4.1.tgz。


## v0.4.2 — 原生设置层次与登录身份（2026-10-05）

- [x] 原生设置页排版：40px品牌图标、24px CLI大标题与副标题；左说明/右控件、细分隔线，导航188px、弹窗800px，模型/强度控件240px；保持36px按钮、固定高度、独立滚动与灰色悬停过渡。
- [x] 账号区显示绿色点+“已登录”及安全邮箱；API只显示“API 登录”。本地会话与CLI状态明确区分来源；读取中、失败及关闭后隐藏旧邮箱。摘要固定52px，不因有无身份跳动。
- [x] AGY按已安装CLI格式读取本地OAuth元数据，仅投影邮箱并标明未远程验证。Codex使用自身account/read获取有效账号源，拒绝通过可能过期的auth.json猜测；4秒/64KiB限制并等待进程范围清理。Claude仅投影已登录claude.ai邮箱，MiMo只显示API方式，Kimi配置仍不是已登录。
- [x] 167项测试（12文件）与Host/Client类型检查通过。新增账号投影/过期/异常/密钥排除、Codex RPC握手/取消/清理及客户端状态边界测试。独立复核44项账号相关测试通过。
- [x] 隔离构建通过；真实Harness浏览器验证AGY绿色状态+邮箱+本地来源、Codex邮箱来自CLI、MiMo API标签无账号字段。未执行真实登录/退出、没有更改账号或模型偏好。
- [x] 隔离亮暗主题验证通过。1280×720窗口modal受限为672px；加载前后摘要Y=242、模型按钮Y=442.5不变，控件240px、摘要52px。浅色按钮实测default rgba(38,49,72,0.06)，hover rgba(38,49,72,0.1)，transition 0.18s。截图 .test-data/evidence/v0.4.2-settings-light.png、v0.4.2-settings-dark.png。
- [x] 正式构建、构建后类型检查与打包通过；更新Desktop链接前确认活动worker=0。安装包 artifacts/dsh-cliworker-now-0.4.2.tgz。隔离服务与测试页已关闭，测试主题恢复。
- [x] 用户解锁后完成Desktop重启验收（2026-10-05 13:12）：确认链接当前0.4.2、活动worker及账号终端为0，重启成功。AGY显示大标题、绿色已登录及邮箱和本地来源说明；Codex显示实际账号，MiMo仅显示API登录；模型目录可加载，原生模型菜单可展开并关闭。未登录/退出或修改账号、开关及模型偏好。截图 .test-data/evidence/v0.4.2-desktop-settings.png。


## ZCode 隔离可行性验证（2026-10-05）

- [x] 本机 ZCode 3.14.4 / CLI 0.16.9 的真实帮助、NDJSON capabilities、反向 runtime preferences 请求与空会话验证；实现 scripts/probe-zcode.mjs，不修改正式执行器。
- [x] 最终离线复测三项 sandbox 边界通过：测试目录可写、目录外拒写、plan 工作区拒写；空闲 app-server SIGTERM 退出及进程组清理通过。证据 .test-data/zcode-probe/run-o2uMDT/report.json；未发送 prompt。探针语法、Prettier 与 git diff --check 通过。原始事件、退出状态与哈希不入 Git。
- [x] 用户明确选择 GLM-5.3-Flash；根据官方目录选择 low 进行短任务验证。首次复用桌面账号的首轮报 Select a model before continuing，当时未执行续聊；后续独立授权结果见下。
- [x] 临时构建官方完整 CLI：独立 Node 24.14.0 / pnpm 10.33.2、冻结锁文件、跳过安装脚本；17 个相关 workspace 构建及完整 CLI 离线探针通过。未替换桌面安装。
- [x] 完整 CLI 原生 BigModel 登录可生成授权链接；首次等待超时并清理退出；续接重新授权成功，见下。探针与接入门槛记录在 doc/zcode-probe.md。
- [x] 续接完成独立 BigModel 原生授权；GLM-5.3-Flash / low 的首轮、同会话续聊、Write JSON 产物和真实流式输出中 SIGTERM 取消均通过。证据 .test-data/zcode-probe/run-4XC18i/report.json；取消退出 143、无最终 result，进程组退出确认通过。
- [x] 只读核验 CLI 数据库：真实选型 GLM-5.3-Flash / low；规划为 mode=build 且 planEnabled=true，文件任务为 edit 且 planEnabled=false。脱敏证据 run-4XC18i/runtime-verification.json。
- [x] build 模式 Write 产生 permission.requested 与 permission.resolved(deny)，目标文件不存在；证据 run-r9wKpm/report.json。CLI 仍退出 0，正式适配必须单独判断权限拒绝。
- [x] 后续已完成正式适配与隔离插件验收；本条仅为探针阶段记录，最终结果见 v0.5.0。


## 六项 CLI 验证汇总（2026-10-05）

- [x] Grok 1.0.0 离线帮助、目录、ACP 与空闲停止/沙箱通过；按用户要求不做订阅模型调用，见 doc/grok-probe.md。
- [x] OMP 16.4.4、Pi 1.0.2 复用用户授权的智谱 GLM-5.3-Flash / low，真实首轮、原会话续聊、Write 产物、沙箱拒写和流中取消通过；OMP 显式 write 审批并关闭模型回退，见 doc/pi-omp-probe.md。
- [x] Harness 0.2.0-rc.2 同一智谱选型的真实首轮、续聊、Write 与只读拒绝通过；独立原生 sandbox 下已观察真实 sleep 后代启动、SIGTERM 后完整清理。双层 Seatbelt 的失败记录保留，见 doc/harness-probe.md。
- [x] OpenCode 1.18.21 的免费 MiMo 原生 run/serve 均远端403；经用户改选智谱后，首轮、续聊、实际文件、SSE中取消和原生权限询问拒绝通过，见 doc/opencode-probe.md。
- [x] ZCode 探针加强 Write 的调用ID/路径/成功结果关联，以及权限 requestID/toolCallID 对应；已有真实事件离线复核通过，没有为此追加模型调用。
- [x] 五个新增探针语法/格式检查和原始报告复核完成。凭据与运行数据均留在忽略目录；未修改原账号配置。
- [ ] 统一接入在隔离 worktree 开始；本次验证提交不代表插件已构建或 Desktop 已更新。


## v0.4.3 — 正式 Logo、紧凑账号操作与登录弹窗（2026-10-05）

- [x] 已确认 official-v1 为最新选定原图，逐字节复制到运行素材，SHA256 `1dab209b70d93af5571dfc24663b6be2b746e48b61d2093f94fddd2cb6156318`；字标与NOW标记使用原生字体/主题，工具栏同步新标志。
- [x] 账号/退出/切换入口同行、红色退出紧邻账号；按用户追加要求恢复切换账号和账号终端的原生浅描边按钮。刷新图标化，移除3条正文说明；账号来源仍可悬停查看。
- [x] 独立原生账号弹窗；初始化失败、20秒等待、12秒清理等待、30秒Host分配上限、重试、迟到终端与取消/断流清理均有明确反馈与互斥。只读复审未发现阻止交付的问题。
- [x] 全套189项测试（12文件）通过；最后描边样式改动后额外设置测试37项及Host/Client类型检查通过。两次隔离构建均成功。
- [x] 隔离Harness真实UI验证亮暗设置页与标题；原生描边实测0.5px、浅色 rgba(0,0,0,0.12)，按钮36px，颜色过渡0.18s。模型查询、设置关闭与局部加载可用，保存按钮在可视范围内。
- [x] 明确标注“模拟账号终端”的真实PTY：点击登录即出现独立弹窗，输入ping得到ECHO: ping；关闭账号弹窗后设置仍可操作，PID5513已不存在。未触发真实登录/退出或修改默认模型/账号。截图 `.test-data/evidence/v0.4.3-synthetic-account-terminal.png`、`v0.4.3-settings-light.png`、`v0.4.3-settings-dark.png`、`v0.4.3-overview-light.png`。
- [x] 隔离预览标签/服务器已关闭，测试主题恢复深色。Desktop更新前活动worker为0、无打开的账号终端。
- [x] 正式构建、构建后类型检查及pack通过；Desktop重启后实际确认新Logo字标、账号同行操作、浅描边按钮、刷新图标与目录加载。截图 `.test-data/evidence/v0.4.3-desktop-overview.png`、`v0.4.3-desktop-settings.png`；安装包 `artifacts/dsh-cliworker-now-0.4.3.tgz`。正式环境未触发登录/退出，设置页留供用户检查。


## v0.5.0 — 六个 CLI 统一接入（2026-10-05）

- [x] 共享 CLI 列表扩展到 11 项，新增 ZCode、Grok Build、OMP、Pi、Harness、OpenCode 独立目录与执行适配器；复用项目偏好、首次选型、两层任务列表、停止、同会话续聊与持久化恢复。原生 RPC/JSONL 分别解析，不混用协议，不静默回退。
- [x] Pi/OMP/Harness/OpenCode 按用户授权复用原生 credentials 服务中的智谱引用，只经子进程环境传递；ZCode 使用本次新授权的独立私有目录。Pi 官方 1.0.2 运行时已固定安装；ZCode 实测 Desktop 内置 CLI 无头入口可用。
- [x] 真实 WorkerRuntime 集成验收：Pi run-lYyKgY、OMP run-js51Io、OpenCode run-0ArlRb、Harness run-Ygfv7g、ZCode run-snDbO7；五个 CLI 各首轮、原会话续聊、JSON 文件任务，共15轮通过。核对原生会话ID、实际模型、工具事件、文件内容/哈希和重开Storage后的时间线。证据位于隔离 worktree 的 .test-data/extended-smoke/。
- [x] Grok 仅完成离线原生目录、参数、协议和取消验证；没有订阅任务验收。OpenCode 免费 MiMo 两次403保留，不规避免费层限制；经用户改选智谱后真实验收通过。
- [x] 私有目录逐层拒绝软链、写配置原子替换，避免 Host 在沙箱启动前越界。进程范围确认退出后权限收敛，跳过软链并拒绝硬链接；目录查询使用独立 query 状态。旧验收数据收敛后共498文件，密钥泄漏0、文件权限异常0；原始宽权限审计保留，366项为ZCode公共插件缓存资源。
- [x] 隔离原生 Harness UI 实测11个导航、六个新增目录查询、模型/强度菜单、原生账号按钮禁用及灰色待确认状态。未保存模型偏好、未执行账号登录/退出。截图 .test-data/evidence/v0.5.0-settings-eleven-cli.png；新增CLI品牌暂用主题文字缩写。
- [x] ZCode明确禁用原生子代理、Skill、工作流/跨会话调度及node_repl。源码与无模型调用反证确认：CLI仍加载用户全局插件/MCP，plan可直接允许未标注破坏性的MCP，edit显式授权也可放行；无头broker仅拒绝ask分支。文档和目录提示保留这一实际边界，不声称完全MCP隔离。
- [x] 最终隔离回归：18文件249项测试、Host与Client类型检查通过；build:preview成功，逐文件哈希确认预览src与最终源码一致。新增测试包含分流协议、原生目录、权限拒绝、取消、状态迁移、凭据引用、并发查询、软硬链接边界；真实停止证据沿用前述原生探针，不追加未授权Grok调用。
- [x] 与 v0.4.3 界面修改完成三方合并，保留其他图标归档改动；主目录18文件271项测试、类型检查、隔离构建、正式构建和pack通过。安装包 artifacts/dsh-cliworker-now-0.5.0.tgz 核验142项，桥脚本齐全且无私有运行数据。更新前Desktop活动worker=0；仅添加本插件智谱凭据引用/ZCode独立目录，其他配置未变。Desktop重启后11个CLI导航与Pi原生目录查询可用，未启动新模型任务或保存偏好。

## v0.5.1 — 六个新增 CLI 的账号入口修复（2026-10-05）

- [x] 根因：扩展 CLI 的任务协议已接入，但 AccountManager 仍统一返回空 actions 并拒绝启动账号终端。移除此占位限制，按真实能力分流。
- [x] ZCode/Grok 使用经原生 help 核验的登录、退出及管理入口；ZCode 完整 0.16.9 离线运行时安装到稳定 managed 路径，3424 文件 SHA256 校验、75包、零符号链接，实际 import TUI 通过。账号与 worker/catalog 共享同一指定来源。
- [x] Pi/OMP/Harness 和有 zaiCredentialRef 的 OpenCode 通过本版原生共享 Store 桥复用原生模型设置；不伪造独立 OAuth 登录或无效退出。Harness 本版无 TUI，管理入口为原生设置。账号状态只显示本地配置事实，不伪称远程验证成功。
- [x] Pi/OMP/OpenCode 原生管理 TUI 沿用同一 API 来源；OpenCode CN模式固定已验证提供商/模型，无ref则使用私有共享原生账号。独立临时目录在失败、取消、进程退出后清理；账号刷新失败不会让已开的原生设置误切成终端。
- [x] 实际隔离页面打开 Harness 原生模型设置；Pi、ZCode、OMP、OpenCode TUI 均已目视确认。OMP首次向导与全局MCP自动发现已修正；无网络、模拟凭据的原生PTY复验确认无向导、无MCP连接、模型可见、0模型任务、最终进程范围为空。证据 `.test-data/omp-account-native-probe/tui-report.json`。
- [x] ZCode/Grok账号终端通过私有launcher使用umask077；在父进程umask022的实际模拟子进程验证中，新目录0700、新文件0600。
- [x] 未执行真实登录/注销或提交凭据，未发送模型任务。Grok 保持离线命令与协议验证范围，没有进行付费/订阅调用。
- [x] 全套21文件331项测试通过，Host/Client 类型检查、隔离构建、正式构建和pack通过；Desktop更新前活动worker=0。
- [x] 解锁后定位并修复 Desktop Client 加载故障：插件重复声明宿主 `settings.section`，触发原生 SlotCore 所有权冲突。改为由框架管理生命周期的共享 Store 桥，关闭插件弹窗后进入原生「模型」设置。新增覆盖两种加载顺序、卸载、能力缺失的回归；本轮3文件68项针对性测试、Host/Client类型检查、隔离/正式构建及重新pack通过。
- [x] 修复后在真实 Desktop 确认11个CLI导航和六个新增管理入口；Harness API入口打开完整原生模型设置，OMP、OpenCode、ZCode原生账号终端均成功显示。OMP/OpenCode展示已配置智谱模型，关闭后相关进程与临时目录已清理；未触发登录、退出或模型任务。截图 `.test-data/evidence/v0.5.1-desktop-native-models.png`、`v0.5.1-desktop-omp-terminal.png`、`v0.5.1-desktop-opencode-terminal.png`、`v0.5.1-desktop-zcode-terminal.png`。正式包 `artifacts/dsh-cliworker-now-0.5.1.tgz` 已重新生成。

## v0.5.2 — 原生登录菜单、账号识别与六款图标（2026-10-06）

- [x] OMP/Pi/OpenCode 登录设置改为原生终端，无 API 凭据前置要求，无模型任务或按键注入；私有账号目录保留，临时终端数据清理。
- [x] ZCode/Grok 原状态只检查文件存在；现按本机格式解析原生本地身份，真实只读检查两者均 authenticated、accountLabel 非空，未输出凭据。
- [x] 用户给出的 ZIP 为旧款；找到并接入项目内 v2-extended 六款PNG，按素材清单统一光学大小和亮暗表现。
- [x] Harness 0.2.0-rc.2 无原生 TUI/登录命令，保留明确禁用说明；未伪造页面、升级 CLI 或跳转原生设置。
- [x] 无网络私有PTY验收中，Pi显示原生认证方式菜单，OMP显示提供商设置页，OpenCode显示 Select provider 登录列表。未提交认证、未请求订阅模型；各进程组退出为空。证据 `.test-data/v052-native-login/`。OpenCode探针使用单层等效文件限制与禁网沙箱，避免macOS禁止嵌套sandbox-exec，不把探针描述成生产沙箱链验收。
- [x] 全套22文件336项测试、Host/Client类型检查通过；隔离构建、正式构建与pack通过，安装包158项、含Pi原生UI入口、无私有运行数据。
- [x] 隔离Harness页面实际打开Pi原生认证方式菜单，关闭终端后设置仍可操作；Grok显示绿色已登录和账号，六款图标暗色可读。证据 `.test-data/evidence/v052-preview-pi-login.png`、`v052-preview-grok-settings.png`。
- [x] 更新前Desktop活动worker=0，隔离worker均终态；预览标签与服务已关闭，未提交认证或保存模型偏好。
- [x] 解锁后重启Desktop加载0.5.2：ZCode/Grok均实际显示绿色已登录和账号，六款新图标在亮色设置页可见；Pi/OpenCode/OMP均打开原生认证菜单后关闭，未选择提供商、提交凭据、退出账号或发送模型任务。Harness显示本版无终端登录界面，按钮禁用。
- [x] Desktop验收额外发现OMP原生向导在300px终端中截断提供商列表；仅OMP终端改为520px，小屏由原生弹窗滚动。2文件55项针对性测试、Host/Client类型检查、隔离/正式构建及重新pack通过；Desktop再次重启确认完整提供商列表。此前受限沙箱内误跑全套测试的3个权限失败（sandbox-exec/ps）保留日志，不视为代码回归。
- [x] Desktop证据：`.test-data/evidence/v052-desktop-zcode-settings.png`、`v052-desktop-pi-login.png`、`v052-desktop-opencode-login.png`、`v052-desktop-omp-login-final.png`。账号临时目录已清理；正式包 `artifacts/dsh-cliworker-now-0.5.2.tgz` 已更新。

## 智能体角色预设与命名（2026-10-06）

- [x] 读取七份用户小说技能，整理为默认角色；保留审稿、规划、修订和草稿授权边界，不执行原技能任务。
- [x] 实现角色库私有持久化、模板 CRUD、每个 worker 的独立快照和临时提示词。
- [x] 原生派遣新增角色问题；稳定命名、重命名、同父会话按名称续聊／状态／停止。
- [x] 标题字标、NOW 对齐与留白调整；设置新增角色卡片；列表与对话显示智能体名称。
- [x] 集成工作区 31 文件388项测试通过；为遵循 Hermes 尚未更新 Desktop 的范围，本轮从 HEAD 8783e5e 单独构建角色功能 0.5.3，未带入 Hermes 或图标归档改动。
- [x] 独立发布目录 `.cache/roles-release` 的26文件354项全套测试、Host/Client类型检查、build:preview、build与pack通过。独立测试首次发现快照夹具漏传自定义worker列表，补回后全套通过；日志保留在其 `.test-data/`。
- [x] 七份默认提示词经独立来源复核；真实隔离Harness页面显示七个卡片，并完成模拟预设新增、搜索及重新打开回读。文件0600；模拟预设只存在隔离profile，不进入Desktop。
- [x] Desktop更新前活动worker为0；备份并更新本插件生成文件后重启，实际确认“智能体名称｜主题”、列表名称/模型/强度、重命名对话框、七个默认卡片及完整提示词编辑表单。未改变原会话名称、模型、登录或任务内容；正式角色库7项、0600。
- [x] 亮色Desktop与暗色隔离页面均目视检查；角色搜索框修正为使用原生Input的span容器铺满可用宽度。生成Host/Remote合同均包含4个新增RPC，未出现404。
- [x] 独立包 `artifacts/dsh-cliworker-now-0.5.3.tgz` 170项，无运行数据或凭据；验证摘要同目录JSON。本轮不发送真实模型任务、不测试小说产出质量。专用隔离预览服务已停止。
- [x] 仅提交本轮角色功能、说明和独立版本号，保留工作区其余并行改动；不推送远程。


## 2026-10-06 — Hermes Agent 隔离接入（v0.6.0）

- [x] 用 Hermes Agent / `hermes` 替换外部 Harness CLI；使用用户 `v3-hermes/hermes.png` 原图。保留 DeepSeek Harness 宿主和旧 Harness 只读历史；旧 session ID、偏好不映射到 Hermes。
- [x] 按用户授权安装官方固定提交 `4787e4d56fc8d9265d4c7d3c0fe5accee86b4078`，实际版本 `v0.21.5+7527.g4787e4d`、Python 3.14.7；跳过浏览器与电脑控制依赖，不安装 Hermes Desktop 或启动 gateway。
- [x] 原生 `model` 登录向导、`auth` 账号菜单、当前服务商/模型目录、stream-json、session_id 续聊、真实 tokens 投影；按原生已公开能力提供强度，未公开能力不猜测。
- [x] 任务/目录查询使用窄范围 Seatbelt 写入白名单；原生账号、config、.env、源码与依赖保持只读。修复并行目录查询的原生安装锁竞争、连续文本分片重复，以及空安装配置被误判为已配置登录。
- [x] 独立工作树 `feat/hermes-integration` 构建与类型检查通过：`pnpm --config.verify-deps-before-run=false build`、`typecheck`、`build:preview`。未将并行“制作智能体”任务的角色实现和文档混入本包。
- [x] 同工作树完整回归：27 个测试文件、371 项通过，包含 7 项实际 macOS Seatbelt 测试，以及取消/进程清理、流式解析、模型目录、账号读取、历史迁移与 UI 用例。日志位于工作树 `.test-data/final-test.log`。
- [x] 真实 CLI 目录验证：默认 provider=auto 时明确要求选型；私有模拟配置经真实 CLI 返回 fixture/model。配置值为模拟，进程与沙箱真实，未调用模型。最终窄策略真实读取 provider 成功退出 0。
- [x] 最终隔离包在 cliworker-test profile 的设置页中显示 Hermes 新图标与未登录状态，不再显示可选 Harness。真实点击“登录设置”显示提供商列表，“账号终端”显示原生凭据管理菜单；均关闭并确认对应进程退出。截图在主工作区 `.test-data/evidence/hermes-final-login.png` 与 `hermes-final-auth.png`。
- [x] 遵照用户“暂时只完成 Hermes 隔离验证，不更新 Desktop”：没有构建主工作区 lib、更新 Desktop 链接或重启 Desktop；隔离测试 profile 使用后恢复原链接。
- [ ] 真实模型运行、续聊和任务停止：本轮未选模型、未提交凭据、未发送模型请求，留待用户选型后验收。协议夹具与登录菜单验证不等同于真实任务通过。


## 2026-10-06 — Hermes 合入当前角色版本（v0.6.0）

- [x] 用户要求将 Hermes 加入当前版本。基于 `6de1b25` 的智能体预设与命名功能，核对隔离提交 `2469f84`：Hermes 独立实现完整，共享 Host/Client/Storage 逻辑保留角色选择、快照、七个默认角色、重命名与按名称续聊。
- [x] 主工作区 31 文件、389 项测试通过，含实际 macOS 沙箱/进程清理测试；组合版本 `build:preview` 与生成合同后的 Host/Client 类型检查通过。未执行模型任务、登录或退出账号。
- [x] 隔离 UI 同时显示 Hermes 设置、新图标与七个智能体预设；旧 Harness 无可选入口。当前 Hermes 尚未明确选择原生服务商/模型，按设计提示先完成登录设置，不伪造目录。
- [x] 组合安装包为 `artifacts/dsh-cliworker-now-0.6.0.tgz`，与先前仅 Hermes 的隔离包分开；保留现有 Desktop 构建备份 `.cache/desktop-before-hermes-060`。
- [x] 用户明确回复“开始吧”允许退出并重启后，完成主目录正式 build 与 Host/Client typecheck，完整退出并重新打开 Desktop，加载组合版本 0.6.0。更新前活动 worker=0、账号终端=0。
- [x] 本机 Desktop 设置显示 Hermes Agent 新图标与入口，旧外部 Harness 无可选入口；点击“登录设置”实际打开 Hermes 原生服务商选择菜单，关闭后无账号进程残留，account-runtime 为空。未选择服务商、提交凭据或发送模型请求；仍需用户明确选择原生服务商与模型后使用。
- [x] 本机七个智能体预设与原有会话完整保留；更新前后 worker、CLI 开关、项目偏好与角色库四份持久化文件 SHA256 均一致。证据 `.test-data/evidence/hermes-desktop-060-login.png`、`hermes-desktop-060-roles.png`；构建及类型检查日志 `.test-data/hermes-desktop-final-build.log`、`hermes-desktop-final-typecheck.log`。


## v0.6.1 字标、设置层级与控件统一（2026-10-06）

- [x] 原生品牌字体、舒展字距、标题与设置按钮居中；模型后紧跟点分隔及思考强度。
- [x] 智能体设置与 CLI 连接同级，联系人图标与缩进子项；平滑收展，隐藏项不可聚焦，当前配置/终端不重建。
- [x] 普通按钮与单行输入统一为原生 MD 36px；返回/取消描边，删除预设红底白字，保留确认与悬停效果。
- [x] 72 项针对性界面测试、31 文件390项完整测试、Host/Client类型检查通过。首次受限环境全套检查中的进程权限错误和缺失图标 mock 已分别通过授权环境运行及补齐夹具解决；不将首次失败记为通过。日志 `.test-data/ui-refine-tests.log`、`ui-refine-typecheck.log`。
- [x] 先完成隔离构建，在 Safari 中实际验证暗色标题、模型排列、联系人导航、CLI 收展及角色编辑按钮；隔离服务停止，profile 包链接恢复。仅查看既有角色，未保存或删除。
- [x] 更新前 Desktop 两个 worker 均 completed，账号终端为0；备份 `.cache/desktop-before-ui-061` 后正式构建、pack，重启 Desktop 加载0.6.1。亮色实际复核字标和 gear 对齐、搜索/新增等高、CLI 收起与角色编辑的红色删除/描边取消；取消编辑返回原会话。
- [x] Worker、偏好、角色库及 CLI 开关文件更新前后 SHA256 一致，七个默认预设仍可见。正式包 `artifacts/dsh-cliworker-now-0.6.1.tgz` 含175项、无测试运行目录或凭据；本轮未发送模型任务。


### 2026-10-06：v0.6.2 标题与卡片优化

- [x] 标题切回 Harness 默认界面字体；NOW 高度 21px → 18px；标题 Logo 改为浅色黑、深色白。
- [x] 浅色 CLI 卡片增加淡灰底色；收起/展开加入宿主动效与箭头旋转，折叠内容无法聚焦或点击，详情返回后保持折叠状态。
- [x] `pnpm typecheck`、面板与设置定向测试 67 项、`pnpm build:preview`、`pnpm build`、打包全部通过。pnpm 使用 `--config.verify-deps-before-run=false` 保留当前依赖安装。
- [x] 隔离 Harness 深色预览核对标题、白色 Logo、卡片收展；本机 Desktop 更新 0.6.2 后核对默认字体、黑色 Logo、NOW、淡灰卡片及收起/展开。未进行逐帧性能测量。
- [x] 更新前确认 2 个 worker 均已完成、账号终端数为 0；更新后 5 个会话/偏好/角色/CLI 设置文件的哈希一致。没有发起真实模型任务。


### 2026-10-06：v0.6.3 卡片悬浮样式

- [x] `Cli Worker` 改为 `CLI Worker`，Logo 与标题的间距减半至 6px。
- [x] 浅色卡片恢复白底，增加原生柔和阴影；深色取消灰底，用同色底面、细轮廓和增强底部阴影表达层次。
- [x] 面板定向测试 23 项通过（同步修正原大小写断言）；`pnpm typecheck`、隔离构建、正式构建及 0.6.3 打包通过。pnpm 保持 `--config.verify-deps-before-run=false`。
- [x] 隔离 Harness 深色页面与本机 Desktop 浅色页面均已目视验证字标、间距、同色卡片和投影；保持收展实现不变。
- [x] 更新前 2 个 worker 均已完成、账号终端为 0；重启后 5 个 worker/偏好/角色/CLI 设置文件哈希未变。未发起真实模型任务。


### 2026-10-06：v0.6.4 正式 Logo 替换

- [x] 三张用户原图接入：浅色标题黑色、深色标题白色、工具栏/空状态/新标签页引导蓝色。归档和运行资源 SHA256 均与 Downloads 原图一致；旧正式版本标记为历史。
- [x] 面板和客户端注册定向测试 27 项通过，Host/Client 类型检查、隔离构建、正式构建和打包通过。pnpm 使用 `--config.verify-deps-before-run=false`。日志 `.test-data/ui-logo-tests.log`、`ui-logo-typecheck.log`、`ui-logo-preview-build.log`、`ui-logo-build.log`、`ui-logo-pack.log`。
- [x] 隔离 Harness 深色界面实际显示白色新 Logo 与蓝色工具栏入口；重启本机 Desktop 后实际显示黑色新 Logo 和蓝色工具栏入口，标题排版与悬浮卡片保持正常。隔离服务已停止并恢复原 profile 包链接。
- [x] 更新前 2 个 worker 均 completed、账号终端为 0；更新后 5 个 worker/偏好/角色/CLI 设置文件哈希一致。未发起模型任务。原构建备份 `.cache/desktop-before-ui-064`。
- [x] `artifacts/dsh-cliworker-now-0.6.4.tgz` 共177项，三张原图均内联并原样打包，不包含测试数据或缓存目录。


### 2026-10-06：v0.6.5 定稿 Logo 接入

- [x] 按用户强调，唯一采用其指定黑色定稿原图；运行文件与归档、原始生成文件逐字节一致。三种配色共享 alpha 蒙版，不使用重新生成的轮廓。
- [x] 27项面板/注册测试、Host/Client typecheck、build:preview、正式 build、pack 通过，日志 `.test-data/logo065-*.log`。
- [x] 隔离 Harness 深色界面验证白色定稿与蓝色入口；正式 Desktop 重启后验证黑色定稿和蓝色入口。隔离服务已停止，测试 profile 链接恢复。初次受限启动未能监听，后以授权的回环服务完成验证。
- [x] 更新前2个worker均completed、账号终端0；更新后5份worker/偏好/角色/CLI设置哈希不变。未执行模型任务。备份 `.cache/desktop-before-ui-065`。
- [x] 包 `artifacts/dsh-cliworker-now-0.6.5.tgz` 共175项，包含定稿原始PNG和配色代码，不包含废弃换色稿、旧蓝白Logo或测试数据。


### 2026-10-07：公开首页整理与 Harness 原生截图

- [x] README 按项目定位、特点优势、界面效果、支持范围、安装更新、使用方法、边界与常见问题、开发验证、文档反馈编号整理；历史逐版本说明移至 `doc/version-notes.md`，保留追溯入口。
- [x] 2026-10-06 晚在真实 DeepSeek Harness Desktop 新建干净演示会话。用户批准 Antigravity / gemini-3.8-flash / low / 无角色预设的单次欢迎语任务；完成原生三项选型，worker 为 completed，结果事件 SUCCESS，无工具事件，回复符合要求。
- [x] 直接拍摄原生任务总览、子对话、角色预设与 OMP 设置四张截图。收起私人会话列表，避开含邮箱的账号页，逐图检查无账号标识、密钥、本机路径或私人内容；来源说明见 `doc/assets/readme/README.md`。未发布独立 React 演示页。
- [x] 相对链接与图片文件检查、公开文本敏感信息扫描、`git diff --check` 通过；核对 GitHub Release 附件和宿主安装入口。此轮仅文档与截图，未重跑业务构建或测试，未变更运行版本。


### 2026-10-07：v0.6.6 天蓝平切 Logo 与同轮廓三色

- [x] 用户选定 `exec-1f96a1dc-5099-4e6e-949c-6b37a295db1d.png` 原图进入运行时；源码、归档、隔离包、正式构建与安装包内 PNG 均逐字节一致。蓝色直接显示原图，黑白共用 alpha 蒙版。
- [x] 面板/客户端注册定向测试 27 项、Host/Client 类型检查、隔离构建、正式构建和打包通过；日志 `.test-data/logo066-*.log`。本轮无业务逻辑改动，未新建镜像式测试或执行模型任务。
- [x] 三色原生 CSS 预览检查 24/32/48px，保存 `doc/assets/project-icon/official-v4/preview.png`；隔离 Harness 深色界面显示白色标题及蓝色入口，正式 Desktop 重启后显示黑色标题及蓝色入口。截图在 `.test-data/evidence/logo066-isolated-dark.png`、`logo066-desktop-light.png`。临时预览页和服务器均已关闭。
- [x] 更新前 3 个 worker 均 completed、账号终端数 0；备份 `.cache/desktop-before-ui-066`。重启后 7 份 worker/偏好/角色/CLI 设置文件 SHA256 未变。未更改其他配置。
- [x] 安装包 `artifacts/dsh-cliworker-now-0.6.6.tgz` 共 175 项，包含选定 PNG；无旧黑色 PNG、测试数据或缓存目录。只本地提交，不推送或发布远程。


## 2026-10-07：OpenSpec 开发流程接入

- [x] 核查 OpenSpec 官方资料、本机发布版与当前源码，固定开发依赖 `@fission-ai/openspec@1.14.1`；新增 `pnpm spec`、`pnpm spec:list`、`pnpm spec:check`。Node v22.23.1、pnpm 11.25.0；`pnpm install --frozen-lockfile --offline --ignore-scripts` 通过。
- [x] 官方 `init --tools codex --profile core --language Chinese --no-animation` 生成六个项目级技能，未改用户全局技能；中文 context、各产物 rules 和 apply/archive guidance 注入检查通过。项目入口关闭本次命令遥测。
- [x] 完成 `adopt-openspec-workflow` 的提案、设计、development-workflow 增量规格与任务；`status` 四类规划产物齐全，严格校验通过。新增 `doc/openspec.md`，同步 AGENTS、README 和设计入口。业务能力域只提供提取索引，不宣称全部完成规格迁移。
- [x] `pnpm typecheck`、`pnpm test`（31 文件 / 390 项）、`pnpm build:preview` 通过；自动测试因本机进程与沙箱夹具需求在获准的本机执行环境运行，不调用真实模型。日志在 `.test-data/openspec-adoption/{typecheck,test,build-preview}.log`。
- [x] 指南相对链接、运行时依赖/exports/安装元数据保持不变、六个生成技能版本、`git diff --check` 检查通过；正式 `lib/` 的 172 个文件 SHA256 前后完全一致。检查报告与指令快照在 `.test-data/openspec-adoption/`（忽略目录）。
- 本次不执行正式 build、Desktop 更新或真实 CLI 模型任务，不提升插件版本；Kimi/Grok/Hermes 以及其他历史真实验收边界继续保留，未虚勾历史任务。原有 Logo 归档和历史文档整理与本次改动分别保留。
- [x] 本次 change 已归档为 `openspec/changes/archive/2026-10-07-adopt-openspec-workflow/`；主规格 development-workflow 含 4 条需求。归档后 `pnpm spec:check`、`pnpm spec validate --archived --strict --no-interactive` 通过，活动变更为 0。

## 2026-10-07：v0.6.7 CLI 路由、原生模型目录与连接状态

- OpenSpec：`fix-cli-routing-model-catalog-health`，覆盖 worker-dispatch、cli-model-discovery、cli-connection-health；规划提交 `dff43bf`，路由提交 `fa5bc7c`，后续实现及交付按阶段本地提交，不推送。
- 路由：统一 agy→Antigravity、glm／zhipu／智谱→ZCode、harmes→Hermes；长名称唯一轻微误差可解析，短名称、歧义、普通讨论、否定与引用不自动派遣。当前步提示通过原生 pre-step 的 accepted human messages 生成；真实 Cordis／SystemPrompt／ToolRuntime 装配、生命周期、角色与权限门槛有回归。原有 skill 和宿主核心未修改。
- 模型：ZCode 原生 builtin＋personal 合并、隐藏／禁用与 manual 覆盖、原生推理参数及完整 ID；本机纯读取目录 21 个模型、9 个 provider。Pi／OMP 读取全局及插件账号、模型配置、缓存和原生环境，同 provider 插件来源优先；Host CN 引用仅用于对应 provider。默认数据目录的账号读取同时覆盖发现和任务启动，新增无子进程参数准备回归，原账号文件未变。
- Pi／OMP 原生离线查询（禁止网络）：仅原生来源 OMP 29 项、Pi 无账号 0 项；明确标注合成 CN 凭据做 metadata 查询时 OMP 39 项、Pi 4 项。源文件前后哈希相同，0 模型请求。证据 `.test-data/model-catalog-health/offline-catalog.json` 与同目录 `offline-check.ts`。原生目录可读不证明远端订阅。
- 续聊：Pi／OMP 精确 provider/model/effort 与 observed 核验、原生 env 和刷新 OAuth 保留、同会话改选和查询取消；ZCode 先原生 metadata resume／setModel／read／close，完全退出后才 headless。真实已安装 ZCode 在全新私有数据、合成 API 配置和原生导入的一条明确模拟历史下，改选 high 后重启恢复相同 session/model/options；仅允许本机 IPC、拒绝外网、没有 send 任务。证据 `.test-data/cli-fixes-067/zcode-native-metadata.json`。探针早期超时来自独立客户端未处理反向 RPC 与空 metadata 会话不持久化，修正探针后通过，未据失败误判生产 wrapper。
- 状态：unconfigured 灰、明确认证失效或配置／读取错误红、unknown 灰、可读原生配置或登录绿；绿灯说明本地或原生 CLI 证据不代表远端验证。导航与账号摘要共用映射，未配置优先于空目录错误；刷新恢复不写模型偏好。脚本路径须为可读普通文件，Node 脚本不要求执行位。
- 最终 `pnpm test`：34 文件、495 项通过；`pnpm typecheck`、`pnpm spec:check`、`pnpm build:preview`、`pnpm build` 与 `pnpm pack --out artifacts/dsh-cliworker-now-0.6.7.tgz` 通过。preview/src 与最终 src 逐文件哈希一致，Host／Remote 合同已重新生成。日志 `.test-data/cli-fixes-067/{full-tests-final,typecheck,preview-build,production-build,production-typecheck,package}.log`。初轮过时目录夹具及取消签名已修正；原生沙箱测试在支持 sandbox-exec 的环境重验，未把受限外层沙箱的失败计为通过。
- 隔离渲染：Tabbit 实际检查灰／红／绿和 ZCode／OMP 多模型，标签显示型号＋provider，保存仍用完整 ID。模拟夹具有独立包元数据，避免误注册原生产 Client；最终截图包含“模拟”标签：`.test-data/cli-fixes-067/ui-health-zcode-multimodel-simulation-final.png`、`ui-omp-multimodel-simulation.png`。该证据不冒充真实模型对话。
- Desktop：更新前全部后台 Worker 已结束、账号终端为 0；旧生成文件备份 `.cache/desktop-before-cli-fixes-067/lib`。本地源码链接加载新构建，重开后在实际设置菜单目视核对 ZCode 多服务商模型、OMP 的原生接口和列表末端 zhipu-coding-plan 模型、Pi 的 4 个 CN 模型；没有选择／保存新默认、提交登录或发送模型任务。CUA 的原生截图在本次聊天工具记录中；摘要 `.test-data/cli-fixes-067/desktop-verification.json`。既有 10 份 worker／preference／CLI 开关／角色文件前后 SHA-256 全相同。
- 安装包共 183 项，新增两个 runtime 脚本齐全，yaml 固定 2.9.1，无 `.test-data`、`.cache`、账号或运行数据。SHA-256：`06a90c50a8be869c6512d14ed6c43ba81bb5c3f95e2bb5e09d9ac8f108829eae`。交付摘要 `artifacts/dsh-cliworker-now-0.6.7-verification.json`。
- 测试隔离事件：一项旧账号测试的失败断言意外把本机自定义 provider 的 API key 带入工具输出。已隔离临时 HOME、账号来源和子进程环境，观察文件仅记录合成值匹配／存在布尔，新增父环境凭据不导入回归；本轮验收及自建临时目录检查匹配文件为 0。未写入 Git，未修改或轮换用户凭据。该事件已经向用户说明，避免将测试成功描述成从未发生过暴露。
- 未做：本轮未用主模型新对话验收自然语言服从，也未发起真实 CLI 模型任务或验证所有 provider 的订阅／远端凭据；已有 Kimi／Grok／Hermes 等历史未验证项继续保留，不能由目录／元数据／模拟回归推断成功。

## 2026-10-07：v0.6.8 账号可用模型、简化名称与免费优先

- 用户反馈后取回并重开 `fix-cli-routing-model-catalog-health`。上一版“原生 available 目录”不能代替当前账号权益，历史验证保留；本轮新增 5.1–5.8 单独记录。规划提交 `3accb39`，展示与 Host 选型提交 `83991ed`，账号筛选与两阶段查询提交 `42e296d`。
- Pi／OMP／OpenCode 将原生候选与当前账号支持范围相交；过期 OAuth、未登录、范围未知、公共大全和仅在自定义配置中声明的模型隐藏。OAuth Codex 检查 supported_in_api 与当前额度允许，OpenRouter 使用账号模型端点；多账号池按共同权限和全部身份费用投影。配置本身与未绑定当前账号的旧成功记录不是权限证据。
- 设置、首次询问、Worker 改选和卡片统一只显示模型名；去掉路由前缀及括号附注，按确切原生型号去重，原始完整 ID 和有效旧偏好保持精确。仅有明确免费价格或免费额度且可用的模型在新选择中优先；unknown、SDK 缺省零值、附加费用和付费订阅额度不当免费。不可用旧偏好要求重选，不自动改默认或转付费。
- 原生账号与配置安全只读，发现与执行采用相同来源和原生认证优先级。Host CN 密钥只在对应子进程 env 使用；不写入请求文件、账号副本或报告。不执行 OAuth 刷新或 shell 密钥命令，不复制用户会话。账号 HTTP 查询限时、限响应体、只读 GET，错误固定去敏。
- 本机真实只读范围核对：仅原生账号 OMP 筛后 5 项，当前免费额度证据为 free；Pi 原生来源没有确认范围，0 项。Desktop 的显式 Host CN 来源下 Pi 确认 GLM-5.3 与 GLM-5.3-Flash 两项。OpenCode 当前账号／原生 CN 交集 6 项：GLM-4.7、GLM-5-Turbo、GLM-5.1、GLM-5.2、GLM-5.3、GLM-5.3-Flash，成本均 unknown。原账号／配置文件哈希不变；0 模型生成、0 OAuth 刷新。证据 `.test-data/model-catalog-health/strict-account-metadata.json`、`.test-data/cli-fixes-068/opencode-metadata.json`。
- 隔离 Harness 渲染已完成：每个 CLI 的 3 个明确模拟路由投影为 2 个模型名，已确认免费路由排前；历史卡片去前缀、括号和去重一致。截图 `.test-data/cli-fixes-068/ui-cards-simulation.png`、`ui-opencode-menu-simulation.png`，摘要 `ui-verification.json`。模拟 UI 不作为真实账号可用性证明；临时服务、页面及浏览器控制租约已结束。
- 实际 Desktop 初次复核发现 OMP 目录失败：外层 Host Seatbelt 与新增内层 sandbox-exec 重复 sandbox_apply，被系统拒绝。独立 native 查询成功不能覆盖已安装路径；当前修复把断网原生候选读取和受控账号 GET 拆为两次单层沙箱查询，任务准备复用同一私有快照，执行继续原生 setModel＋observed 核验。准备元数据进程无法确认退出时使用固定类型清理错误，阻塞后续任务并保留状态目录，不报告停止成功。
- 最终完整回归：39 文件／564 项通过，Host／Client 类型检查、严格规格校验、preview 构建、正式 build 与 pack 通过。源码 75 个文件与隔离 preview 逐个哈希相同；Gateway 合同重新生成。日志 `.test-data/cli-fixes-068/{full-tests-final-3,typecheck-final-3,spec-check-final-3,preview-build-final-3,production-build-final,package-final}.log`。初轮两项旧 OpenCode 集成夹具因未隔离全局大缓存失败，现已使用明确模拟账号和 nativeHome 修正，不把首次失败计为通过。
- 真实 OMP＋合成 Host 引用的生产装配探针通过：候选外层断网、scope 阶段允许受控 GET、同一私有快照，5 个已确认原生账号模型；源账号／配置哈希不变，生成和 OAuth 刷新均 0。最终候选文件仅保留身份／路由／强度及 header 名称，0600，合成 Host key 扫描不匹配；准备阶段清理边界与队列回归通过。证据 `.test-data/model-catalog-health/managed-omp-two-phase.json`。
- Desktop 在全部 7 个 Worker 已结束、账号终端 0 后重建并重启，原构建备份 `.cache/desktop-before-cli-fixes-068/lib` 保留。真实 Host 引用下设置菜单：OMP 14 个去重模型，已确认免费额度的 5 项排前；Pi 2 项；OpenCode 6 项。OMP／OpenCode 的实际 Worker 改选菜单分别与设置的 14／6 项一致，公共 Ling 已不在可选项中。原不可用 gpt-5／Ling 偏好提示重选，均未保存；卡片已显示 GLM-5.3-Flash／gpt-5／ling-3.0-flash-fin-free 等纯名称。CUA 原生截图保存在本次聊天工具记录，未冒充模型生成成功。
- 正式包 `artifacts/dsh-cliworker-now-0.6.8.tgz` 共 192 项，账号查询 helper、类型配套与 OpenCode native 模块齐全；无测试数据、缓存、账号或运行文件。SHA256 `b0d6d94f4f8e37f72f55efc6e1aacddf5d86341189dbf2bef5ff364e4ad7ca2b`，生产链接指向当前仓库。14 份既有 Worker／偏好／角色／CLI 设置文件检查中均未改变；最终验收摘要见 `.test-data/cli-fixes-068/desktop-verification.json` 和 `artifacts/dsh-cliworker-now-0.6.8-verification.json`。
- OpenSpec 收尾：21／21 任务有对应实施与验收记录，三个能力域逐需求核对后同步主规格；重新归档至 `openspec/changes/archive/2026-10-07-fix-cli-routing-model-catalog-health/`。归档后严格主规格 4／4、归档变更 2／2 通过，活动变更为 0；本地分阶段提交，不推送，既有无关工作区改动保留。
- 未做：没有提交新默认选型、登录操作或真实模型请求；主模型自然语言服从、所有 provider 的远端任务成功及未来余额／服务状态仍无本轮验收证据。未知账号范围继续隐藏，不通过付费模型请求试探权限。


## 2026-10-08：v0.6.9 六款 CLI 设置加载、登录证据与独立身份

- OpenSpec `repair-cli-settings-discovery`：规划提交 `026b7ad`，实现提交 `8a9f673`。统一账号先查、模型随后加载；刷新/失败清旧目录，跨 CLI 或过期响应拒绝，模型与强度按原生能力联动。仅原生认证成功证据显示绿色，本地凭据及 Host 引用保持待验证。导航与摘要一致，账号来源说明完整换行。
- OMP/Pi 的工具指引、程序身份及入口分离；同模型不互换 CLI。Pi 原生 1.0.4 优先，1.0.2 兼容安装须核验；两个版本均完成离线 SDK/login API 与 RPC `get_state`/`get_available_models` 核对，fetch/prompt/login 均为 0，进程在有意 SIGTERM 后以 143 退出。错误身份、取消及清理未确认边界有回归。证据 `.test-data/cli-settings-069/pi-native-offline-results.jsonl`。
- 六 CLI 本机只读检查：初轮 ZCode configured/local，Grok 明确失效，OMP configured/local，Pi/OpenCode 原生未配置但显式 Host 来源可发现模型，Hermes 真实入口失效。OMP 14、Pi 2、OpenCode 6 个筛后模型；42 份原始账号/配置/运行文件 hash 不变，0 生成、0 登录提交。证据 `native-check.json`，不把目录结果当真实模型成功。
- ZCode 初轮因原生大写 canonical ID 与账号 API 小写 ID 的差异得到空目录。生产凭据 GET 的详细诊断曾被自动审批拒绝，随后用户明确授权一次只读查询；批准后仅对绑定 BigModel 原生 `/api/anthropic/v1/models` 发出 1 次 GET，HTTP 200、11 个小写模型，0 刷新/生成，4 份源文件 hash 不变。未再次发送真实请求。报告 `zcode-authorized-model-list.json`。
- 修正仅限精确官方 individual provider/accountType/Anthropic endpoint，采用 installed ZCode 明确的有限官方 GLM 别名表；其他路由继续 exact 匹配，执行保留 canonical ID。原生目录与该次授权响应的完整离线重放得到 GLM-5.3、GLM-5.3-Flash，均 low/high/max；4 次本地 transport 中只有对应账号匹配，其他返回模拟 404，网络/意外出站/生成均 0，5 份源文件 hash 不变。证据 `zcode-recorded-models-replay.json`，重放不冒充第二次实时查询或生成。
- ZCode 加密口令显式只传对应子进程；当前 identity 的 key、目录发现、login/manage/logout、headless/resume 一致，密钥不进入 argv、文件或响应。Anthropic 原生双认证头仅该路由启用。Hermes 账号范围按原生优先级与账号池交集，拒绝 disabled provider、外部 Codex app-server 身份、未知端点/secret 命令；Grok 公共 ACP 目录不冒充账号权限。
- 最终 `pnpm test` 42 文件 / **631 项通过**，`pnpm typecheck`、严格规格校验、`pnpm build:preview`、正式 `pnpm build`、`pnpm pack --out artifacts/dsh-cliworker-now-0.6.9.tgz` 通过。pnpm 使用 `--config.verifyDepsBeforeRun=false`，完整测试在获准的本机沙箱环境执行；子任务一次误用测试参数导致全套嵌套沙箱失败已停止，不计为通过。日志 `.test-data/cli-settings-069/{full-tests-final-with-alias,typecheck-final,preview-final,production-build-final,package-final}.log`。
- 隔离 Harness 实际渲染六款账号语义、加载/失败/重试、换模型后强度变化；Pi/OpenCode 有 Host 模型仍保持未原生登录灰点。说明区域 height 与 scrollHeight 均 36px，无截断。截图 `.test-data/cli-settings-069-ui/final-opencode-host-source-simulation.png` 明确标注模拟；只读 fixture 事件仅 account/catalog，账号动作、偏好写入、真实模型任务均 0；自有页面与18749服务已关闭。
- 正式 Desktop 更新前9个worker全部结束、账号终端0；旧lib备份 `.cache/desktop-before-cli-settings-069/lib`。完整重启后原生设置确认账号/模型加载禁用状态、ZCode/OMP/Pi/OpenCode中性、Grok/Hermes错误状态及Hermes明确原因；没有保存偏好或提交登录。17份worker/preference/开关/角色文件集合和SHA256均不变。原生截图在本次CUA工具记录，摘要 `desktop-verification.json`。ZCode实时诊断仅使用上述一次用户授权GET，未为Desktop截图重复触发它。
- 包共207项，81份源码与最终preview逐字节相同，正式入口与包内容相同，包含新增原生安装解析helper，无测试/缓存/账号数据。SHA256 `bbfa34a46e1e78bc56c4758a11e4b691e0d14172205997e6ed8fb1daeb549829`，交付摘要 `artifacts/dsh-cliworker-now-0.6.9-verification.json`。
- 保留边界：未发起六CLI真实生成/续聊、未提交登录或刷新OAuth，主模型实际工具服从未新增生成验收。Grok 尚无可核验的当前账号 Worker 模型权益接口，故未确认候选不供选择；Hermes 未知provider/账号池仍不放行。本机Hermes原源码根已改名，旧shim失效；虽facts.json能定位完整构建环境，官方要求源码launcher优先，不能以snapshot替代其安装身份和生命周期，需另行恢复原生安装。本轮没有改全局launcher或恢复用户已改名目录。历史Kimi/订阅等缺口保持可见。
- OpenSpec 主规格已逐条核对并同步，9/9实施与验收任务完成；归档 `openspec/changes/archive/2026-10-08-repair-cli-settings-discovery/`。归档前严格校验5项、归档后主规格4项与全部归档3项均通过，活动变更0；仅本地提交，不推送。


## v0.6.10 — 原生登录识别与简洁账号文案（2026-10-08）

- [x] 按用户新截图修正 Antigravity/ZCode 的已登录误判，并统一各 CLI 设置的一行账号信息。OpenSpec `correct-login-status-and-settings-copy` 的提案、增量规格、设计及任务先行；实现提交 `e4e5167`，不推送远端。
- 根因：v0.6.9 客户端把 `verification=local` 当成未验证身份，将 Antigravity 的原生可续用会话降级。ZCode 则仅将当前原生账号绑定标为配置。当前按原生状态显示登录，ZCode 还核对受支持 active provider、当前 identity、原生用户记录及该 identity 的绑定 key；普通 API fingerprint、旧/孤立 key、身份不符及未知 provider 不升为已登录。未改变模型权限筛选或执行参数。
- 设置移除正常账号的长 detail、重复 tooltip 和远端验证/隐私声明，只显示短状态、必要身份及操作；真实错误保留短原因。Hermes 启动入口错误统一为“启动入口不可用，请修复安装”；终端关闭失败仍阻止提前重启。
- [x] `pnpm typecheck`、42 文件／656 项完整模拟测试及严格规格检查通过。最后仅精简 Hermes 两条安装错误文案，相应15项回归再次通过；最终 preview/build 均含 Host/Client 编译，81个源码文件与 preview 完全一致。日志 `.test-data/cli-settings-0610/{typecheck,full-test,hermes-copy-test,spec-check-final,preview-build-final,production-build,package}.log`。
- [x] 本机原生账号离线检查：Antigravity 和 ZCode 均为 `authenticated / oauth / local`，3份原文件哈希不变；网络、刷新、登录、生成和子进程均为0。脱敏证据 `.test-data/cli-settings-0610/native-login-check.json`。本轮未重复前次已授权的 ZCode 模型 GET，也未重新执行模型任务。
- [x] 隔离 Harness 以明确模拟数据覆盖6种账号界面，AGY/ZCode绿色、OMP已配置、Pi/OpenCode未登录、Hermes错误；账号文本高度均22px，detail为0，错误与按钮不重叠，不通过省略长段落伪装单行。刷新后旧成功消失、模型禁用，失败重试和模型强度联动通过。证据 `.test-data/cli-settings-0610-ui/ui-verification.json` 及3张 `*-simulation.png`；自有页面0、服务正常退出、18750端口无监听。
- [x] 正式更新前9个worker均已结束、账号终端0，旧lib备份 `.cache/desktop-before-cli-settings-0610/lib`；重启 Desktop 后实看 Antigravity/ZCode 绿色、Hermes短错误单行。打开 AGY 时正常模型查询仍加载，切换 Hermes 后取消，未作为新模型验收。17份既有worker/偏好/开关/角色文件集合与SHA256均不变，未保存偏好或提交账号操作。CUA原生截图在本次工具记录，摘要 `.test-data/cli-settings-0610/desktop-verification.json`。
- [x] 正式包 `artifacts/dsh-cliworker-now-0.6.10.tgz` 共207项，与本机构建逐项一致，无凭据、测试或运行文件；SHA256 `933283004984885e4495c5a57ca70ade8c6c4e52a6753536e586d61326c4de96`。Desktop链接仍指向本仓库。验收摘要 `artifacts/dsh-cliworker-now-0.6.10-verification.json`。


## v0.6.11 — 全部 CLI 自身账号与模型隔离（2026-10-08）

- [x] 按已批准方案覆盖全部 11 个 CLI；OpenSpec `isolate-cli-account-models` 先行，规划提交 `a3db50f`，实现分阶段提交 `1703dd5`、`be73f58`、`d47a61f`、`6679d71`。移除 Harness 凭据解析和注入、父进程通用 API 密钥、跨 CLI 自动读取及可确认的插件合成路由；保留本 CLI 原生账号、插件登录目录、自有配置中的 API Key 和限定目录的私有 `.env`。旧 Host 引用仅兼容解析，不再使用。
- [x] 模型与强度按本 CLI 原生能力和当前自身账号范围求交，前五 CLI 同样不接受公共目录、旧缓存、Claude 固定别名或无账号免费模型作为可调用依据。Host 私有账号绑定覆盖保存、新建、出队及续聊，任务准备后再次核对；换号、退出、撤权、模型或强度失效均拒绝。无绑定的升级前历史保留查看，但要求新建任务，不替旧会话认领当前账号。
- [x] Pi/OMP 独立核验安装身份和账号优先级，OAuth 续期以稳定主体、当前来源和原生锁／SQLite 条件更新约束；Host 租约只在进程范围确认退出后释放。Hermes 的交互导入入口也受跨 CLI 凭据读取禁令保护。MiMo 在原生配置初始化前拒绝未经核验的环境／文件插值、托管远程配置及外部 provider 导入，检查覆盖目录和执行；账号状态只读自身 Auth，登录终端使用隔离的配置上下文。
- [x] 最终源码 `pnpm typecheck`、`pnpm test`（52 文件／869 项）、`pnpm build:preview`、`git diff --check` 通过。测试使用明确模拟的账号、模型服务和临时目录，覆盖全部 CLI 的外部账号拒绝、自有范围、旧缓存／快照、账号切换／退出、相同模型、无效强度、取消和进程清理失败；真实本机 PTY、Seatbelt 和回环测试在允许环境中执行。日志 `.test-data/cli-isolation-0611/{typecheck-restored-final,full-test-restored-final,preview-restored-final}.log`；最终源码与 preview 逐字节相同，受测源码／测试／构建输入另存 SHA-256 核对。
- [x] 较早阶段的本机离线来源审计未发起原生子命令、网络、登录刷新或模型生成。Antigravity、Codex、ZCode、Grok、OMP 的本地来源绑定可确认；Pi、Hermes、OpenCode 未确认自身可用账号；Claude、Kimi、MiMo 需原生命令的部分跳过，未冒充真实成功。脱敏记录 `.test-data/cli-isolation-0611/native-source-audit.json`。
- 保留能力边界：Grok 尚无已核验的当前账号模型范围；Claude/Kimi 的未支持 OAuth、Codex 未支持的凭据存储或自定义路由、无可核验稳定主体的 Pi/OMP OAuth 均不放行。OpenCode 1.18.21 OAuth 原生续期没有安全的版本条件写回，不能保证外部退出不被旧进程恢复，因此保留真实登录状态，但模型与执行暂不开放；自身 API 配置可按范围使用。Hermes 本机原启动入口仍失效，本轮未修复其安装。未知范围显示空列表及简短原因，不以模型生成探测补证。

- 用户实机反馈后修复 Antigravity/MiMo 回归：账号显示与模型目录状态解耦；Antigravity 恢复自身 consumer 原生 models 目录；MiMo 安全读取自身 Auth、隔离账号终端免受项目模型配置影响，保留网页登录 API metadata.base_url，并解析原生 verbose 头部 window/compacts 信息。身份确认不必等待模型列表；重复在途状态读取合并但不缓存结果，Codex 先单次原生 account/read，OMP 仅缓存按真实安装版本绑定的能力检查。
- 本机恢复证据：Antigravity 原生 models 单次查询 4.578 秒返回 14 个原生变体，0 生成；用户明确授权的 MiMo 官方 GET /v1/models 仅 1 次，HTTP 200、688 毫秒、9 个账号模型，与 6 个原生代码候选相交保留 5 个，剔除账号未支持的 mimo-v2.5-pro-ultraspeed 与不适用的音频条目。证据 `.test-data/cli-isolation-0611/{agy-native-model-metadata,mimo-native-models,mimo-authorized-model-scope}.json`。此前 MiMo 网络诊断被自动审批拒绝，取得专门授权后才执行，没有绕过。
- 本机账号状态读取各测 10 次：Antigravity 首次 4.26ms／中位 0.28ms，MiMo 首次 0.45ms／中位 0.17ms，两者 authenticated；0 子进程、0 网络、0 生成。该耗时仅指 Host 本地账号读取，不当作整页或远端模型加载耗时。证据 `login-load-benchmark.json`。

- [x] 最终隔离界面验收覆盖全部 11 CLI：无账号灰点／空模型／禁用保存；自身 API 模型与强度切换；模型刷新失效、失败和恢复；Antigravity/MiMo 模型待加载或失败仍保持已登录；账号刷新保留身份直到新结果；Pi/OpenCode 原始异常类前缀移除。账号行实测均为 22px，4 张截图实看。最初 fixture 缺少独立包名，曾解析到旧 Client；修正后全部重跑，并从浏览器网络层下载实际脚本，核对与最终 preview 的可执行字节完全相同。证据 `.test-data/cli-settings-0611-ui/ui-verification.json`，Client SHA-256 `81224fef478bc740f7f3bb40f2e9ae8c61554a8066b0fd0fcf7e5ed51f80fa75`；旧轮次只作历史记录，不作为最终通过依据。模拟服务、浏览器页及 18751 监听已清理。
- [x] 最终更新前确认 10 个历史 Worker、0 活动任务、0 账号／任务桥进程；保留原 0.6.10 lib 备份，正式构建后重启 Desktop。实机 Antigravity 在模型加载时已显示登录与一行身份，随后下拉菜单出现 7 组模型（14 个原生强度变体）；MiMo 导航为绿色，自身账号读数与唯一授权模型查询另有证据。为避免重复远端查询，未打开真实 MiMo 详情页，详情布局由隔离模拟覆盖。Pi/OpenCode 均未登录且模型／强度／保存禁用，原因保持一行。关闭设置回到原会话，未登录／退出、未保存偏好、未生成模型内容。证据 `desktop-verification.json`，原生界面截图保留在本次 CUA 记录。
- [x] 数据核对：最终更新前基线的 44 份账号、配置、历史、偏好文件全部哈希不变；另行核对 MiMo 原生账号／配置／Git exclude 的前后哈希及早于本次任务的修改时间。较早首次基线有 2 份配置（Codex/Hermes）在首次正式更新前发生变化，归因未确定，保留当前内容未回滚；该阶段凭据、历史和偏好均未变。记录 `original-state-check-pre-release.json`、`post-update-state-check.json`、`post-final-update-state-check.json`、`mimo-native-source-check.json`，不将最终基线结果扩大为整段会话所有配置从未变化。
- [x] 正式包 `artifacts/dsh-cliworker-now-0.6.11.tgz` 共 237 文件，SHA-256 `8db29b1dddd050d6f4b813724fe413b199823bad0a2ba758ab3531bcf2259523`。包内容与构建核对一致，动态辅助模块相对导入完整，无测试／账号／缓存／运行数据。Host 与 preview 逐字节相同；Client 仅构建位置产生的 node_modules 区域注释路径不同，可执行文本完全相同。验证报告 `artifacts/dsh-cliworker-now-0.6.11-verification.json`；真实模型生成 0。

- [x] 3 个能力域的 8 条增量需求逐条同步主规格并核对文本一致；归档前 6 项严格校验、归档后 5 项主规格严格校验通过，任务 9/9，活动变更 0。归档为 `openspec/changes/archive/2026-10-08-isolate-cli-account-models`；能力限制和未做模型生成的边界保留在本记录及规格中。源码、文档和归档分阶段本地提交，不推送。


## 2026-10-08：v0.6.12 原生登录入口与 Grok 账号目录

- OpenSpec：`repair-native-cli-login-entrypoints`；规划提交 `952cd76`，实现提交 `d7d7c92`。本轮修复 Kimi、OMP、Hermes 登录入口及 Grok 目录，不取消全部 CLI 自身账号隔离。设置继续只显示必要单行信息；详细诊断留在聊天与本记录。
- Kimi：原生当前 provider OAuth 引用必须对应自己的有效或可续用令牌，缺失、撤销、过期不能续期与普通 API 配置分开。已有账号的 `kimi login` 会直接复用并退出，没有原生 force 参数；改为“管理登录”打开原生 TUI，由用户明确 `/logout`、`/login`，插件不自动退出。全部账号操作使用 0700 独立空目录，设空 Git/MCP 边界阻止上溯用户项目，退出后按 inode 清理。实际 Desktop 已见“已登录”、管理按钮及独立目录的原生 Trust 提示；未接受 Trust、未输入退出/登录、未生成，关闭后临时目录已移除，原令牌哈希不变。不能将到达 Trust 菜单写成已完成账号切换。
- Kimi 版本：本轮早先本机为 0.42.0，原生 TUI 随后显示更新通知；最后对 Host 实际解析的执行文件在禁写、禁网沙箱仅运行 `--version`，返回 2.1.1，前后哈希相同。当前二进制与早先哈希不同，README 按 2.1.1 记录；之前 0.42.0 的生成 403 仍是历史证据，本轮未重新执行生成或主动运行升级命令。
- OMP：原生 `setup` 会写 `agent` 同级 `logs`，只给规范化的自身日志子目录补写权限。16.4.4 空账号禁网原生菜单及实际 Desktop 提供商菜单均打开，原日志 EPERM 消失；未选提供商或提交认证，退出后进程范围清理。实际 Desktop 关闭菜单后的首次状态读取曾失败，手动刷新恢复“已配置”；之后两次只读原生/Host 检查成功，没有可识别的 SQL 锁或读取竞态诊断，未可靠复现根因，未加入猜测性重试。该瞬态问题仍保留观察，不计为已根治。基线覆盖的三份 OMP 配置未变；基线不含数据库，原生菜单更新了插件自身数据库，不能声称数据库字节不变。
- Hermes：显式账号操作建立插件独立原生目录及目录外来源标记，状态、目录、账号绑定和执行统一来源，退出不回退全局旧账号。精确允许原生 source/provider，继续阻断其他 CLI 导入、安装源码 `.env`、旧全局环境及外部密钥命令；自身 `.env` 禁插值和账号上下文重定向。复用已安装官方 checkout `6c80c32734` 的既有 venv，原生锁内核验 committed facts 并持 generation lease；不触发新账号目录下的依赖重装。最终源码禁网菜单和 Desktop 的 Select provider 菜单可见，未选提供商、未提交认证，关闭后仍未登录；全局原账号/配置/历史保留。
- Grok 官方只读核查：分别严格使用用户一次授权 GET `/v1/models` 和一次授权 GET `/v1/settings`，均 HTTP 200、账号文件未变，没有重试、刷新账号或生成。模型返回 `grok-4.7`、Grok 4.7，强度 `low/medium/high/xhigh`；独立 Build 门禁返回 `allow_access: true`。因此不能将此账号空列表归因于没有订阅；模型目录可读也不能单独证明调用权限。旧插件没有接通自己的认证目录查询，且原生匿名 fallback 的 `grok-4.5` 与新目录不一致。现在先确认同账号官方门禁，再取官方模型与当前原生能力交集，换号/退出/取消丢弃结果，错误不混为无权益，不向设置页加入长说明。
- Grok 原生能力：实际安装 `1.0.0 (3cd0d0cbcebe)` 在禁外网、空 HOME、合成 key 的本机回环模拟 metadata 服务下，原生 ACP 返回 `grok-4.7` 及四档强度，确认该精确版本支持动态目录；其他版本保留原生候选交集。该证据是原生协议的模拟元数据验收，不是当前账号真实生成。实际 Desktop 更新后未重开 Grok 详情，以免超出两次只读授权；尚未验证实际生成、额度消耗和服务端生成限制。
- 最终自动验证：`pnpm typecheck`、`pnpm test` 通过，55 文件／932 项；`pnpm build:preview`、`pnpm build` 及 `pnpm pack --out artifacts/dsh-cliworker-now-0.6.12.tgz` 通过。命令使用 `--config.verifyDepsBeforeRun=false`；完整测试在支持原生 PTY、Seatbelt 和本机回环的环境运行。覆盖令牌缺失/撤销、外部账号拒绝、菜单权限、来源贯通、门禁、错误/取消、账号变更与清理；0 真实模型生成。主要日志 `.test-data/native-login-0612/{typecheck-final,full-test-final,preview-final-build,production-build,package}.log`。
- 隔离界面：Tabbit 加载隔离 Harness 页面和明确模拟账号/目录，核对 Kimi 已登录+管理登录，OMP/Hermes 未登录+登录设置，Grok 已登录但未知权限时空目录禁用；账号行均为 22px、无附加说明段。浏览器实际加载的 Client 与最终 preview 逐字核对，仅 Gateway 封装分隔及 source map 不同；正式 Client 与 preview 仅构建路径注释不同，执行代码一致。截图 `ui/kimi-login-simulation.png`、`ui/ui-verification.json`；浏览器任务、临时服务和端口已清理。模拟页面不替代真实账号授权验收。
- Desktop：更新前保留旧构建备份并确认 10 份 Worker 记录中活动任务 0、账号/任务桥接进程 0；先完成隔离 preview，再正式构建更新本地链接并重开 DeepSeek Harness 0.2.0-rc.2。实际菜单见本轮 CUA 截图/辅助功能记录，摘要 `.test-data/native-login-0612/desktop-verification.json`。44 份既有账号/配置/历史/偏好基线文件哈希全部不变，另对最终 Kimi 菜单前的 1 份令牌核对不变；未将未基线的 OMP 数据库纳入此结论。新增 Hermes 私有来源目录/标记是显式登录入口需要的状态，未复制旧账号。结束时账号终端与设置已关闭，Desktop 留在正常面板。
- 包验证：251 个文件，98 个源码文件与最终隔离 preview 相同；Host 完全相同，两处 `hermes-native-entry.py` 资产与源码相同，包内文件逐个匹配构建，pnpm 仅规范化移除 `packageManager`。无测试、账号、私有日志或运行数据入包。SHA-256 `428db572f4a4d2180665dc0702c89e6dc3bac39826130213625390b8cdc097d0`；摘要 `artifacts/dsh-cliworker-now-0.6.12-verification.json`。最后的 README 版本校正后已重新打包和校验；未改执行代码，无需重复 Desktop 更新。
- 未验证/保留事项：未提交任何 CLI 登录、未执行 Kimi Trust 后的切换、未新建真实模型任务；Grok 的 Build 许可及目录不等于额度或生成成功。OMP 关闭菜单后的瞬态状态失败仍按上述现象记录。本轮私有证据位于 `.test-data/native-login-0612/` 和 `.test-data/grok-account-probe-0612/`，不提交 Git；用户原有图标整理及既有文档改动不纳入本轮提交，不推送远程。
- 归档前严格校验：`pnpm spec:check` 的 5 个主规格和本变更共 6 项全部通过。实现、自动检查、隔离/原生菜单、Desktop 与交付文档共 7 项任务均有上述对应证据；模型生成、登录提交及 OMP 瞬态读取的边界保持可见。
- 最终规格复核将新增的“退出不回退全局账号”明确限定为 Hermes 独立来源；Pi/OMP 原有全局与插件自身来源合并未被文档误写成已改造。三个新增要求已同步至主规格且逐块核对，使用 `--skip-specs` 避免归档时重复合并；变更归档于 `openspec/changes/archive/2026-10-08-repair-native-cli-login-entrypoints/`，7/7 任务，归档后 `pnpm spec:check` 的 5 个主规格通过，活动变更为 0。

## 2026-10-08：v0.6.13 服务商登录与 Hermes Nous 修复交付

- OpenSpec：`fix-provider-login-status-and-hermes-catalog`；计划提交 `b1487be`，实现提交 `7a7005c`。原因已确认：四个 CLI 的自身认证投影固定返回 configured，Client 因而正确显示灰点；Hermes 的 Nous 扁平 OAuth、账号绑定和目录实现缺失，已授权账号无法进入模型查询。
- Pi/OMP/OpenCode：79 项专项及类型检查通过；只读本机状态为 authenticated。Pi、OpenCode 均显示 zai.cn API 登录；OMP 分别显示 OpenAI 账号登录及其独立 API 服务商，不混淆认证方式。66 项来源存在性/哈希检查中 24 个现存文件均不变；该探针 0 网络、0 原生登录、0 续期、0 生成。
- Hermes：7 文件 147 项专项通过；最后统一 TTL、恢复非 Nous 查询顺序及原生强度交集后，Nous/集成 2 文件 45 项通过。覆盖匿名/过期/退出/换号、pool 不一致或未初始化、原生路由与自身环境配置、无付费过滤、未知/额外费用、无 tools/图像模型、取消/超时/重定向/体积限制、途中源及冷却改变、同源并发旧取消和有效期跨门槛。原生证据版本 `6c80c3273468`；真实查询不调用原生命令或刷新器。
- 用户明确授权 Hermes 自身 Nous 凭据访问两个官方只读 GET 后，诊断读取到账户无付费访问权和 430 条模型元数据；最终 Host 验证 `/api/oauth/account` HTTP 200（606ms）、`/v1/models` HTTP 200（468ms），过滤为 10 个明确免费模型，其中 3 个提供显式强度，其余仅 default。绑定稳定，auth/config/来源标记 3 项哈希不变，临时运行目录已清理；无生成、无续期。约 1.1 秒仅为此次两请求耗时，不是启动总耗时承诺。
- 自动验证：最终 `pnpm typecheck`、`pnpm test`、`pnpm build:preview`、`git diff --check` 通过；全量 58 文件 1014 项。首轮全量仅失败于非 Nous 原生 scalar 查询顺序，恢复原顺序后全量重跑通过。未以修改测试期待掩盖回归。
- 隔离 UI：Tabbit 本地独立 profile 使用明确模拟账号和目录，四个 CLI 显示绿点与服务商登录类型，登录文字高度 22px；混合/长服务商单行省略且不遮按钮。API 身份标记不渲染，稳定目录失败仍保留有效登录，缺账号灰点且禁用模型。浏览器实际返回的 Client 与最终 preview 逐字核对，仅 Gateway 分隔符/source map 注释不同；关闭自建页、释放任务、停止模拟服务器。模拟未读真实凭据、未生成、未保存偏好。
- Desktop：确认 10 个历史 Worker 中 0 活动、0 账号/任务桥接进程，备份旧 lib 后退出并正式构建更新。实际安装仍链接当前仓库；重启后四个 CLI 侧栏绿点，Hermes 显示 Nous 账号登录及自身身份，模型下拉顶部/底部可见的 10 项与 Host 实测一致。其余三个服务商细项由本地 Host 与隔离渲染核验，本次未打开它们的远端目录。未点保存、未退出/切换账号、未生成；59 份基线账号/配置/Worker/偏好文件前后哈希完全不变。
- 包：`artifacts/dsh-cliworker-now-0.6.13.tgz`，257 文件、100 源文件与最终 preview 对应，Host 相同、Client 可执行内容相同，包内逐文件匹配，pnpm 只移除 packageManager 元数据；无账号、测试或私有日志入包。SHA-256 `7eb2b43abd94cdf6f063c428e7fce7780ac7155a816fc06c935a6f09882e1939`。验收摘要 `artifacts/dsh-cliworker-now-0.6.13-verification.json`，私有证据 `.test-data/provider-login-0613/` 不提交 Git。
- 边界：未执行真实模型生成或续聊，元数据成功不写作推理成功；既有 OMP 原生菜单关闭后偶发状态失败、本轮范围外订阅/权限限制不宣称已根治。保留用户既有图标及文档改动，只提交本次范围，不推送。
- 规格交付：三个能力域新增 3 条要求并修改 1 条既有状态要求，原 Purpose 与既有场景保留；同步前后严格校验共 6 项通过。6/6 任务均有上述证据，归档于 `openspec/changes/archive/2026-10-08-fix-provider-login-status-and-hermes-catalog/`；使用 `--skip-specs` 避免重复同步，归档后 5 个主规格通过、活动变更为 0。

## 2026-10-09：v0.6.14 账号摘要与退出入口交付

- OpenSpec：`unify-account-actions-and-summary`，规划提交 `9f3d782`，实现提交 `41edf53`。OMP/Pi/Hermes 原先缺少 logout 动作，导致共享按钮变为禁用浅色；现接原生退出入口。OAuth 账号行只保留订阅服务商，完整安全方式放在悬浮详情；Kimi 从当前原生令牌的 `kimi-auth` 稳定主体投影简短账号 ID，本机未保存邮箱或昵称，不远程查询或刷新令牌。
- 退出实现：原生/插件多个自身来源先选择，Host 重读当前来源；Pi 直接使用所选 auth 文件，OMP 仅链接所选真实认证 DB、SQLite sidecars，配置/缓存/会话私有。Hermes 当前 home 不迁移，原生 auth Remove 只允许认证/环境文件的精确写路径，退出进程禁网；`suppressed_sources` 同时约束状态、模型及绑定，避免保留配置值恢复已退出账号。环境/模型配置 API 不在 Pi/OMP 原生删除范围，需原配置管理；未声称一键清除全部来源。
- 自动验证：Host 专项 5 文件 116 项，Hermes 状态/模型/绑定等 5 组 137 项；最终根目录与隔离 preview 的 `pnpm typecheck`、`pnpm test`、`pnpm build:preview`、正式 `pnpm build`、`git diff --check` 通过。全量 60 文件 1078 项。首轮仅 Hermes 特殊字符路径临时写权限失败，修正 SBPL regex escaping 后保留原测试重跑全部通过；没有放宽整个目录写权限。
- 原生临时验收：已安装 Pi 1.0.4、OMP 16.4.4 在假账号目录出现 Select provider to logout 和模拟 Anthropic 凭据，禁网、拒读真实账号、未选择凭据；退出码 143、进程组已退出，临时目录清理完成。真实 Seatbelt 测试另证 Pi auth 写入/锁和 OMP 链接数据库的 WAL 删除落在所选来源，其他来源/配置不可写，Hermes 原子临时文件可写但配置/历史/兄弟目录/网络不可用。Hermes 原生菜单能力经安装源码核对，本次未在真实账号内打开或移除凭据。
- 隔离 UI：Tabbit 模拟 profile 检查 OMP/Pi/Hermes/OpenCode/Kimi 五行，账号文字均 22px 单行；五个退出按钮 class、65×36px 尺寸及可用状态一致。OMP 可见“OpenAI账号登录”，不拼接 API 或邮箱；安全详情保留；Kimi 模拟 ID 可见。未选/取消来源零启动，选择 plugin 才发送 `accountStartForSource`；假 Host 拒绝操作后显示简短通用错误并可关闭。浏览器资源与最终 preview 可执行文本相同，最后 Host 修复后 Client SHA-256 未变。自建网页关闭、任务释放、服务器停止，0 真实账号操作/偏好写入/生成。
- Desktop：更新前 10 个历史 Worker、0 活动、0 账号/任务桥进程，备份旧 lib；正式构建后原生退出并重启。实看 OMP“OpenAI账号登录”、Pi“zai.cn API 登录”、Hermes“Nous账号登录”、Kimi“已登录 + 当前脱敏 Kimi ID”，退出按钮可用且一致。仅查看，不点击真实退出、保存或提交登录；页面正常模型加载随切换/关闭取消，不将此写作模型调用验收。回到原会话后 59 份账号/配置/Worker/偏好基线哈希全不变，无账号/任务进程残留。
- 包：`artifacts/dsh-cliworker-now-0.6.14.tgz`，263 文件、102 源文件与最终 preview 对应；Host 字节相同，Client 仅构建路径区域注释不同，可执行内容相同，包内逐文件匹配且无账号/测试/私有日志。SHA-256 `5a0dc4d2e8cedbd694f456e04da4f15a36e6cf14e642dad9173a77ffd821104b`；验收摘要 `artifacts/dsh-cliworker-now-0.6.14-verification.json`，详细证据 `.test-data/account-actions-0614/` 不入 Git。用户原有图标及文档整理保留，真实模型生成和真实账号退出均为 0，不推送。
- 规格交付：1 条既有摘要需求更新、2 条新需求同步主规格，原 Purpose 和既有场景保留；4/4 任务有对应证据。同步前后各 6 项严格校验通过，归档于 `openspec/changes/archive/2026-10-09-unify-account-actions-and-summary/`，归档后 5 个主规格通过，活动变更为 0。

## 2026-10-09：v0.6.15 原生保护、Windows 与双语 GitHub 发布

- 用户明确取消插件附加 OS 沙箱，改用各 CLI 自身保护；账号边界改为 Host 仅识别自身来源、不注入 Harness/其他 CLI 凭据。OpenSpec `native-cli-protection-and-windows-release`，方案 `b9e9d49`、实现 `d28817b`；已合并远端用户两个 README 改动（`c452d5c`），不强推或覆盖。所有 sandbox-exec/SBPL 包装和专用 OS 限制测试退役，保留原生工具模式、宿主规划/只读拒绝、账号版本、模型/强度、互斥和取消。Hermes 原生无只读派遣能力，和 Kimi 一样明确拒绝。
- Windows 实现：官方固定 Node/Bun npm shim及 Hermes Python fallback 参数数组执行，未知 runtime/batch 拒绝，不拼 cmd /c；任务使用 Host Win32 Job，交互保留 ConPTY。盘符/UNC根、Claude ProgramFiles、MiMo 当前原生认证直连、OMP 子进程配置根/真实退出源、文件身份前后核对、Windows非秘密环境与POSIXmode/目录fd差异均修正。MiMo/OMP不复制认证恢复旧账号；保留 model/catalog/account 来源一致。
- 本机验证：最终 macOS 61 文件，60 通过、1 个 Windows专属文件跳过；1112 项通过、7 项跳过。首次仅4个Hermes旧plan fixture失败，按新明确拒绝规则改为accept-edits测试账号/TTL，独立plan拒绝保持；57项相关回归通过。后续Grok/账号读取和Node/Bun启动6文件124项通过、1项跳过。类型检查、隔离 preview、正式 build、pack和diff检查通过，真实生成0。
- 真实 Windows CI：[37878883989](https://github.com/SuperWheel/cliworker-now/actions/runs/37878883989)，Windows x64、Node22.23.3、Bun1.3.14，99项通过、1项POSIX测试跳过。真实Job后代停止/AbortSignal、ConPTY echo关闭且保留无关进程、真实Python固定fallback、11CLI临时自身来源/他CLI与Harness不能冒充/换号退出均通过。官方Codex0.160.0、Pi1.0.4、OMP16.4.4版本/帮助及实际PiSDK查询通过；空auth候选数0。首轮OMP缺平台optional native叶包，恢复完整官方依赖；第二轮Pi空fixture models.json缺providers，修正为原生schema后通过，不跳过SDK或移除版本sentinel。无真实凭据、登录或模型生成，不把此记作逐模型推理验收。
- 双语首页：默认中文README.md、完整README.en.md，各22个本地链接/全部锚点、4张相同历史真实截图通过；主安装代码块只一行无上下注释，额外步骤折叠。Tabbit线上实际点击中文→English→中文，两页22标题和全部截图/平台标记加载正确；默认分支已更新至b18dcb2。关闭自建页并释放任务，未更改用户网页。源码及历史截图版本范围保留，不将旧v0.6.5图片写成新版截图。
- Desktop：更新前10个历史Worker、0活动/账号桥进程，备份旧lib，确认原生退出后正式构建并重启。实看原会话/任务恢复、Antigravity自身账号、OMP“OpenAI账号登录”、Pi“zai.cn API 登录”，关闭设置且无残留进程；不点真实登录/退出/保存，不生成。59份更新前账号/配置/历史/偏好基线哈希全部不变。Client渲染逻辑与v0.6.14已验收版本相同，仅21处Typert Host诊断源码行号变化，保留对应比较证据。
- 包：`artifacts/dsh-cliworker-now-0.6.15.tgz`，267文件、105源码文件对应最终preview；Host相同，Client仅构建位置区域注释不同，包内逐字匹配，无账号/缓存/测试/运行日志。SHA256 `53940b097ee37c930c35dacf0b0eef1aa522d6c5b287845df0f6860a4b50334d`；包含README.en和全部动态helpers。公开Release为 [v0.6.15](https://github.com/SuperWheel/cliworker-now/releases/tag/v0.6.15)，最新稳定版，目标提交b18dcb2530843899647921c5ecc067c95925b60c，附tgz、SHA256SUMS.txt、verification.json。首次短target SHA被API拒绝，改完整SHA；16MB上传HTTP/2停滞，保留草稿后用仍保持TLS校验的HTTP/1重试。三项远端资产回下载逐字节匹配且服务端digest一致，未替换任何旧Release。
- URL安装：独立DSH_HOME、自建release-install-check profile执行公开Release URL；pnpm第一次下载重试后正常完成，包0.6.15、profile.bundles注册和6个关键文件与正式包一致。用户Desktop原链接/原profile未被验证安装覆盖。详细证据 `.test-data/windows-release-0615/` 私有不入Git；本轮只推送明确授权的代码/双语首页与验证记录，保留86项用户原有素材/文档整理。
- 规格归档：cli-account-isolation更新1条自身账号需求，新增platform-runtime的3条和package-distribution的2条；既有Purpose/场景保留。8/8任务真实完成，归档前严格校验6项、归档后7个主规格通过，活动变更0，归档路径 `openspec/changes/archive/2026-10-09-native-cli-protection-and-windows-release/`。


## 2026-10-09：v0.6.16 派遣询问流程简化

- [x] 项目与 CLI 保存模型、实际支持的思考强度、角色及账号绑定；主对话另存已确认快照。首次完整选型，新主对话询问沿用或重新选择，同对话后续派遣不重复提问；旧版仅含模型/强度的偏好需补做一次完整选型。
- [x] 删除问题卡的灰色选项描述、项目路径与说明段落，统一为选型和沿用两类询问；更新工具指引、Client 等待文案、中英文 README 和角色文档。设置页默认模型说明改为“新对话沿用的默认模型”。
- [x] 回归覆盖所有 CLI 的设定隔离、账号/模型/强度失效、Host 重启、无角色、预设快照、跨对话默认更新、查询取消、并发等待者取消、发起者取消、关闭清理及写入失败。全量测试 **62 文件通过、1 文件跳过；1164 项通过、7 项 Windows 专项在 macOS 跳过**；最终一行 Client 文案调整后另跑 3 文件 49 项通过。根目录和 preview 类型检查通过，严格规格校验 8/8 通过。
- [x] 最终隔离构建与当前 105 个源码文件逐字一致。在真实 Harness 原生问题卡中使用明确标注的模拟账号/模型/角色，完成首次选型、同对话免询问、新对话沿用、新对话重选四条路径；事件记录分别验证问题顺序及无 detail/description，四次 launch 均被夹具截断，**本轮模型生成 0 次**。四张界面截图已检查，浏览器实际加载的插件模块与 preview 可执行内容哈希一致。模拟页面、服务器和子进程已清理，activeRuns=0。
- [x] 更新前核查 12 条 Worker 记录，无 running/queued/stopping 或账号/任务桥接进程，Desktop 两个后台任务均已结束。退出后正式构建并打包，重启后插件页实际显示 **v0.6.16、运行中**，原来的 Hermes/Pi 子任务和主对话可见。
- [x] 原账号、配置与 Worker/偏好基线 64 文件中 63 文件逐字不变；另一个 Codex 全局配置差异在更新前已存在，本轮未修改或恢复。8 个额外主会话历史文件中 7 个逐字不变；当前会话原始 87592 字节完整保留，宿主重开时仅追加 81 字节的 session/end-seed 记录。未退出账号、未替换历史数据。
- [x] 本地包 `artifacts/dsh-cliworker-now-0.6.16.tgz` 共 267 文件，逐项匹配正式构建；Host 与 preview 完全一致，Client 仅构建位置的 node_modules 区域注释不同、可执行内容一致。SHA-256：`fe266c100c186b2508dfa54213c516e3b3ef66cbea8554211313981078e78805`。私有日志、界面证据和校验记录位于 `.test-data/dispatch-flow-0616/`，不纳入 Git。仅提交本轮源码、测试、规格和文档追加，不包含既有素材归档及历史文档整理，不推送。


## 2026-10-09：v0.6.17 派遣指引源头修复交付

- 根因核对：真实会话第一步自建角色问题，第二步才收到当前 agy 指引；对照 Harness 0.2.0-rc.2 AgentLoop 源码确认 assemble 早于 pre-step。修复同次请求上下文与工具入口说明，未采用问题拦截。
- `pnpm typecheck` 通过；定向测试 62 项通过；`pnpm test` 62 文件通过、1 文件跳过，1165 项通过、7 项跳过。严格规格检查 8 项通过。pnpm 使用当前已安装依赖（`pnpm_config_verify_deps_before_run=never`），未自动重装依赖。
- `pnpm build:preview`、`pnpm build` 与打包通过。267 个包文件核对，105 个源码文件与预览一致；Host 完全一致，Client 仅构建路径 region 注释不同。包哈希及结果见忽略目录 `artifacts/dsh-cliworker-now-0.6.17-verification.json`。
- 原生 UI 隔离验收：辅助插件补独立 package.json 后重跑，确认实际客户端来自 `.cache/preview-package`。首次依次显示模型和强度／角色；新对话仅沿用问题；同对话零新增问题。三次 assemble→pre-step 均在同次准入消息中得到正确 agy 指引，原生通用提问工具可见，原用户消息未改。模拟目录与启动替身，不访问真实账号、不生成内容。
- Desktop 更新前 15 个 Worker 中活动数 0，账号／任务桥接进程 0；退出后构建更新本地链接，原生插件页确认 v0.6.17 已启用、1 个组件运行，恢复原会话页面。核对 4151 个基线文件，其中 4150 个账号、偏好和历史等文件哈希不变，仅正常重启更新 `host.lock`。
- 隔离服务器与浏览器验收任务已清理。实际结果、日志、截图及数据保护核对位于忽略目录 `.test-data/dispatch-question-0617/source-*` 和 `source-ui/ui-verification.json`；撤回拦截草案的早期记录不作为本次完成证据。
- 本地提交、不推送；原有文档图片和历史文档改动保留，未混入本次提交。OpenSpec 变更 `fix-dispatch-guidance-timing` 完成后同步并归档。


### v0.6.18：修复 Hermes 漏参误派 Antigravity（2026-10-09）

- 根因证据：真实会话 seq103 请求 Hermes，seq104 已提供 cli=hermes 提示，seq108 工具参数只有 prompt/title，seq109 被旧默认值派为 Antigravity；后续模型停止错误任务并显式传 Hermes 才成功。未修改此历史记录。
- 修改：cliworker_start 原生参数 cli 必填，删除处理器的 Antigravity 缺省值；同步同请求路由提示、工具说明及中英文 README。保持历史记录兼容，不新增拦截或询问。
- 验证：Host/Client 类型检查通过；针对性测试 64 项通过；完整回归 1167 项通过、7 项跳过（62 文件通过、1 文件跳过）；严格 OpenSpec 校验通过；预览构建、正式构建、打包与源码/包一致性校验通过。
- 隔离原生界面模拟：先在同对话放入 Antigravity 选型、项目放入 Hermes 选型，漏参没有目录查询/问题/启动副作用；显式 Hermes 的沿用卡显示模拟 model-a/high/模拟审校员，提交仍为 Hermes。采用真实 Host 选择流程与原生问题卡，阻断真实进程及远端账号访问；模拟退出后 activeRuns=0。
- Desktop 更新：更新前 17 个 Worker、0 活动任务、0 账号/任务桥进程；更新后插件页显示 v0.6.18、已启用、1 组件运行中，并返回原对话。更新前 4163 个基线文件中 4162 个未变，仅 host.lock 随重启更新；原生账号、偏好与历史保留。
- 本轮没有发起真实模型生成。私有证据保存于忽略目录 `.test-data/hermes-dispatch-0618/`（根因、测试、模拟截图、包校验、数据保留记录），不入 Git。打包 SHA256：bf693240d3a66094dd7ca6893498fb33914666d16613df69c33c74afeef7f54d。
- 按 OpenSpec 完成核验后同步规格和归档；只提交本轮变更，不包含原有文档/资源修改，不推送。


## v0.7.1：原生聊天交互与 Desktop 验收（2026-10-09）

- OpenSpec `align-native-chat-interactions`；本轮限定子对话返回最新按钮、消息功能条、续聊键盘交互。原生私有组件无独立公开入口；公开图标及主题直接复用，私有规则按 rc.2 实现。新增 `composer-keymap.ts`，保留所选 Worker 身份、现有权限/续聊限制、成功清稿和失败留稿。
- `pnpm typecheck` 通过；键盘/面板定向 2 文件 63 项通过；全量 Vitest 63 文件通过、1 文件跳过，1201 项通过、7 项跳过。首轮受限环境测试有单 worker 无进展并手动中断，不计成功；同一源码在可用本机环境重跑完成。证据 `.test-data/native-chat-071/{typecheck-final,targeted-final,tests-final}.log`。
- `pnpm build:preview` 先完成并验收。Tabbit 在独立 HOME/DSH_HOME、真实 preview 插件和原生 Harness UI 上使用明确标记的模拟对话：亮暗主题 34px 圆球及 shadow/hover 与原生计算样式逐项相同；历史整条功能区 opacity 0/80ms、hover/focus、真实末条常显；即时回底、历史阅读遇新消息保持位置；Enter/Ctrl/Cmd 发送、Shift 换行、IME/229/确认短窗口、空白/repeat、防重复、失败草稿保留和重试一次均通过。早期验收脚本的跨环境数组比较、元素选择及 IME 窗口时序已修正后重新核对，不冒充产品通过；回执 `ui/ui-verification.json`、截图 `ui/circle-comparison-light.png`。只调用夹具模拟续聊，真实 CLI/模型生成 0，夹具进程、浏览器页和任务已关闭。
- 严格规格校验归档前 8 项通过。确认 Desktop 的 20 个 Worker 中活动数 0、账号/任务桥进程 0，退出应用后正式 `pnpm build`、`pnpm pack --pack-destination artifacts`，包逐文件及 preview 源码/Host/Client 一致性核对通过。Client 仅构建位置的 node_modules region 注释路径不同，执行文本相同。包 270 文件、106 源码文件；SHA-256 `56889e7cdf6d86400dbb6bdf33dec529353809e84a633d5296ee6e23adf76df7`；摘要 `artifacts/dsh-cliworker-now-0.7.1-verification.json`。
- 原生 Desktop 辅助功能 UI 确认 v0.7.1 启用、1 组件运行，原会话和子对话恢复、续聊框可见；没有在生产会话发送测试消息。更新前 4182 文件基线中 4181 个哈希不变，仅 `host.lock` 随重启变化，无文件丢失；账号、偏好和已记录历史保留。证据 `idle-before-update.json`、`desktop-verification.json`、`state-preservation.json`。本轮不新增远端查询或真实生成验收，不修改 Harness 核心；原有图标整理及文档改动继续保留，不推送远程。

- 交付收尾：实现提交 `1b06c77`，OpenSpec 4/4 任务完成；新建 `worker-conversation-interaction` 主规格的 3 条要求，Purpose/场景与增量逐块核对。同步后严格校验 9 项通过，归档后 8 个主规格通过、活动变更 0；归档 `openspec/changes/archive/2026-10-09-align-native-chat-interactions/`。仅本地提交，保留原有未提交改动。


## v0.7.2：智能体管理与 Desktop 验收（2026-10-09）

- OpenSpec `polish-worker-management` 覆盖后台弹层、短名称、大写强度、历史缺绑定新建、原生右键管理及名称复制；补充进程清理未确认在重启后继续阻塞。保留账号隔离、原生权限、两层任务和原始历史。
- 最终 `pnpm typecheck` 通过；完整 Vitest 67 文件通过、1 文件跳过，1270 项通过、7 项跳过。清理持久化新增 14 项模拟回归；Host 管理、迁移、重建、磁盘失败、取消、账号变化及 Client 管理/复制/草稿均覆盖。严格规格归档前 9 项通过。证据 `.test-data/worker-polish-072/{typecheck-final,test-final,spec-final}.log`。
- `pnpm build:preview` 后使用独立 HOME/DSH_HOME、最终真实 Host/Client 与原生 Harness 界面模拟验收：22 项检查通过，含原生 jobs 菜单跨侧栏命中/点击、关闭还原；短名不截断、100ms 悬停复制、不误开卡片；右键/Shift+F10、标题独立编辑；删除重载恢复同 ID；旧会话发送前禁用、明确新建/Enter、新 Worker、旧历史保留；Low/High 选项。最终 Host 重启再次核对持久标题/历史/菜单/缺绑定入口。账号、模型和新建执行接收方为明确模拟，未运行 CLI 或模型。早期夹具 Jobs API 和验收标签/布局帧等待已校准，失败脚本不计产品通过。证据 `ui/ui-verification.json`、`ui/menu.png`、`ui/new-dialog.png`。模拟服务与自建浏览器任务均已退出并清理；信号退出码130，实际进程已核对消失。
- Desktop 更新前 21 个 Worker、0 活动任务、0 账号或任务桥进程；退出后正式构建、打包和逐文件校验通过。包 282 文件、110 源码文件；源码和 Host 与 preview 相同，Client 仅 node_modules region 注释路径不同，执行文本一致。SHA-256 `f578bb199d50a9e0e864204f230c9a492436558a24b5359ed31094ec9b05445d`；报告 `artifacts/dsh-cliworker-now-0.7.2-verification.json`。
- 原生 Desktop UI 确认 v0.7.2 启用、1 组件运行，原会话恢复，agy/codex/hermes 短名与 Low 可见，右键菜单及真实旧 9cffdf 的「新建对话」/禁用续聊可见；未在真实会话提交消息或管理修改。数据基线 4189 文件：4174 哈希不变、13 Worker 只改名称/来源/别名、host.lock 重启变化，无文件丢失。`~/.codex/config.toml` 于17:10在正式构建及更新前出现外部配置变化，单列保留；本轮代码不写该路径，其账号认证文件与插件偏好/事件/历史均未变。证据 `desktop-verification.json`、`state-preservation.json`。
- 本轮无真实模型生成或远端账号查询，不修改 Harness 核心或用户 skill。仅本地提交本轮范围，保留原有图标/文档修改，不推送远程。规格核验及归档在交付收尾完成。

- 交付收尾：实现提交 `1a3cafb`，OpenSpec 7/7 任务完成；新建 `worker-management` 主规格的6条要求，Purpose/要求/场景与增量逐块一致。同步后严格校验10项通过，归档后9个主规格通过、活动变更0；归档 `openspec/changes/archive/2026-10-09-polish-worker-management/`。仅本地提交，原有未提交修改保留。


## v0.7.3：总览和编辑布局验收（2026-10-09）

- OpenSpec `refine-panel-layout`；固定搜索/四筛选及淡红垃圾桶、独立卡片滚动、紧凑两种编辑弹窗、无图标名称文字复制、标题下历史提示横条和无图标两行空页。只改 Client，保留原 Host/协议、账号隔离、草稿与历史；README 及设计同步。
- `pnpm typecheck` 通过；完整 Vitest 68 文件通过、1 文件跳过，1295 项通过、7 项跳过；严格规格10项通过，preview 构建通过。组件专项覆盖复制hover/leave/keyboard/慢结果/销毁、编辑保存失败/取消，以及筛选/恢复/旧任务新建，未以CSS断言代替视觉验收。证据 `.test-data/layout-polish-073/{typecheck-final,test-final,spec-final,preview-final}.log`。
- 最终真实 preview Host/Client + 原生 Harness 界面的隔离模拟验收30项通过。两输入/保存右缘误差0px，标题Modal164px、名称196px；滚动前后搜索/filter坐标相同，列表滚动起于filters下；trash淡红alpha.09、四筛选保留、恢复同ID；名称SVG0、到分隔符7px；hover1300ms保持已复制、leave1018ms恢复，pointer焦点不阻碍。1000/760px窗口无横向溢出，宿主实际右栏仍约543.5px，未冒称验过320px。历史横条位于标题下、不在输入区，显式新建/取消草稿及原事件不变；空页无图标，只有约定两行。最早弹窗截图处于原生进场动画，已在opacity1后重拍，不改core。证据 `ui/ui-verification.json` 和五张最终截图。
- 模拟账号、目录和followup/restart接收方阻断真实生成/CLI/外网请求；存储管理RPC使用实际插件。18774服务wrapper/Host均退出，自建Tabbit页/任务清理完成，残留页0。实际模型生成、远端账号查询及真实CLI均为0。
- Desktop更新前只读核对21个Worker、活动任务0、账号/任务桥进程0；原生界面工具随后报告Mac锁定，已请求用户手动解锁。当前仅preview验收完成，正式build/pack与Desktop更新及更新后数据核对仍待解锁；不将该交付任务标为完成、不归档隐藏此缺口。

### v0.7.3 Desktop 交付补验（2026-10-09）

- 用户解锁后再次核对21个Worker、活动任务0、账号/任务桥进程0；通过原生菜单正常退出Desktop，并确认主进程已结束，再运行正式 `pnpm build` 和 `pnpm pack --pack-destination artifacts`，均通过。
- 包 `artifacts/dsh-cliworker-now-0.7.3.tgz` 含285个文件，SHA-256 `7a0a357cadec7421c90322446dece474034372c3cce7d1b5da939c792fae9f56`。包逐文件匹配正式构建，111个源码文件与preview一致；Host逐字相同，Client仅构建目录产生的node_modules区域注释路径不同，所有可执行内容匹配此前30项原生UI验收。记录 `artifacts/dsh-cliworker-now-0.7.3-verification.json`。
- 原生Desktop插件详情显示v0.7.3、启用、1组件运行中；安装后核对两种编辑弹窗的全宽及紧凑布局（仅打开与取消）、异常右侧淡红垃圾桶、名称到分隔符间距及无图标、固定搜索筛选和下方独立滚动、标题下历史圆角提示条与新建入口、输入区无重复提示、两行无图标启动页。保留旧任务禁用发送行为，未实际新建或发送，最后回到原“你好问候开场”会话。
- 更新前后4189个原账号、配置、偏好和历史文件哈希核对：4188个完全相同，仅允许重启生成的 `host.lock` 改变；缺失0、意外变化0。更新后21个Worker、活动0、账号/任务桥进程0；本轮真实模型生成0、远端凭据查询0。记录 `.test-data/layout-polish-073/{desktop-verification,state-preservation}.json`。
- 先前Mac锁定的交付缺口已补齐；实现已按阶段提交为 `b4db1a2`，保留原有未提交改动；本轮不推送。现可完成OpenSpec最后交付任务，随后同步和归档本change。

- OpenSpec最后交付任务已核对完成（5/5）；主worker-management规格完整替换2块、增加3块，Purpose和其余4块及全部旧场景保持。同步后严格10/10，归档到 `openspec/changes/archive/2026-10-09-refine-panel-layout/` 后严格9/9、活动change0。本次交付补验和归档另作阶段提交，不推送。

## v0.7.4：卡片与回收站修复实施（2026-10-09）

- OpenSpec `fix-worker-overview-regressions`，对应用户六项回归：首卡顶部边缘、名称按钮包围、整行箭头和移除省略号、回收站四筛选返回及选中颜色、多层模型名称、默认强度文字。源头分别为列表顶部零内边距、filter与showArchived转换缺失、箭头仅属于标题行、名称水平padding为0，以及展示函数只去掉一层路径。
- Panel/name-copy专项72项通过，覆盖四种筛选从回收站返回、query与旧筛选保留、右键/键盘菜单、独立复制、删除恢复。模型展示/Worker管理/设置/派遣展示专项181项通过，覆盖多层Hermes tuple与同名不同组织ID/能力不变、default标签和保存值；不以CSS断言替代最终视觉验收。日志 `.test-data/card-regressions-074/{targeted-tests,presentation-tests}.log`。
- README中英及设计同步；前三项实施已完成，完整集成检查、preview原生UI及Desktop更新仍需实际完成后追加记录，不将专项结果当作整体交付完成。

- 集成检查：`pnpm typecheck`通过；完整Vitest 68文件通过、1文件跳过，1304项通过、7项跳过；严格规格10/10通过；`pnpm build:preview`通过。独立源码审查确认显示清理不改原生分组身份/执行ID，Menu实际anchor保留原生焦点恢复。
- 最终preview+原生Harness隔离UI35项通过：首卡顶缘8px留白、名称左右4px、整行箭头中心差0、无省略号；回收站四筛选正确返回且query保留，浅暗主题深红白图标；右键/键盘菜单与Escape还焦、正常打开和复制隔离；复制hover1250ms保留、leave1029ms恢复；Hermes卡/详情/菜单/设置只显示ling-3.1-flash和默认，两次模型选择RPC都保留完整tuple及default，原模拟Hermes/legacy Worker和events四文件不变；长列表scrollTop500进入/返回保持500，滚回顶部仍完整，旧缺绑定任务仍禁发。1000×780px窄窗口实际右栏543.5px、宽窗口右栏656.5px，无横向溢出且固定控件不动，未冒称320px已验。
- 18775隔离wrapper/Host均退出，自建Tabbit页面0、任务finish无issues。启动时一次subprocess尝试被guard拒绝，真实CLI、远端请求和模型生成均0。原账号/偏好/历史4189文件更新前哈希全部相同。证据 `.test-data/card-regressions-074/ui/{ui-verification,model-id-verification,cleanup-verification}.json`及六张截图。

### v0.7.4 Desktop 交付（2026-10-09）

- 原生Desktop更新前21个Worker、活动0、账号/任务桥0；通过原生菜单正常退出并确认主进程已结束，正式 `pnpm build`、`pnpm pack --pack-destination artifacts`及包验证通过。实现阶段本地提交 `d403b9b`，未推送。
- 包 `artifacts/dsh-cliworker-now-0.7.4.tgz` 含285文件，SHA-256 `e5d276c0bf7c994c6f3daf881566efd663c0b4fcc0a06e56958f9c6f92ad1a1a`；111源码与最终preview相同，Host逐字一致，Client仅node_modules区域注释相对路径不同，所有可执行内容与35项最终UI验收一致。
- 重启后的原生插件详情显示v0.7.4、启用、1组件运行中。安装后实际查看Antigravity完整顶缘、名称留白、无省略号及整行居中箭头、Hermes显示ling-3.1-flash和默认；实际进入已删除视图，查看灰色四筛选和深红白图标，并逐一通过全部/进行中/已完成/异常返回正常列表及对应选中态。恢复原“调用Antigravity工具说你好”会话的全部列表，没有新增、删除、改名或发送实际任务。
- 原账号/配置/偏好/历史4189文件中4188逐字不变，仅重启的host.lock允许改变，缺失0、意外变化0；更新后21个Worker、活动0、账号/任务桥0。真实模型生成0、远端凭据查询0。证据 `.test-data/card-regressions-074/{desktop-verification,state-preservation}.json`与 `artifacts/dsh-cliworker-now-0.7.4-verification.json`。

- OpenSpec最后交付任务已核对完成（5/5）；主worker-management规格完整替换4块、增加1块，Purpose和其余5块及全部旧场景保持。同步后严格10/10，归档到 `openspec/changes/archive/2026-10-09-fix-worker-overview-regressions/` 后严格9/9、活动change0。本次交付和归档另作阶段提交，不推送。

## v0.7.5：状态条与名称字距（2026-10-09）

- 已核查原生rc.2展开新会话按钮38px；Client状态条由32px调整为38px。无会话输入区说明从JSX移除，原草稿、历史、错误以及输入/按键/表单阻塞保持。
- 名称按钮扩大但文字起点保持，首个全角分隔符改细线；名称与模型到线的距离按文字边缘等距，左右留白及长名省略保留。名称复制16项与Panel56项定向回归通过。
- 后续集成、隔离渲染与Desktop交付结果将按实际执行追加；默认不发起真实CLI/模型请求。

- 集成检查实际通过：pnpm typecheck、pnpm test（68文件/1304通过、7跳过）、pnpm spec:check（10/10）、pnpm build:preview。隔离真实原生UI21项通过，banner与原生按钮均38px；v074→v075名称字起点不变，按钮增加8px，两侧字距11px、button到线3px；短/长名及实际543.5px窄pane均完整。无会话提示节点0且输入/发送禁用；新建取消保留草稿，复制离开1037ms恢复，原生右键及回收返回通过。所有消息/账号/目录为模拟，真实CLI/模型/远端请求0，临时Host/Tabbit页面已清理。证据：.test-data/card-polish-075/ui/ui-verification.json及4张截图。

- 正式交付：更新前21 Worker/活动0/账号或任务桥0，原生退出Desktop后正式pnpm build、pnpm pack及包完整性核查通过；v0.7.5共285打包文件，111源码与preview一致，Client仅构建路径注释不同、执行文本一致。包SHA-256 dbc77e03ffa6a257d3384038c34a615accbdfcbdc8e6a5dc0ac97285bbbc115f，artifacts/dsh-cliworker-now-0.7.5-verification.json记录结果。
- 已安装Desktop原生核对v0.7.5、启用及1组件运行；原标题下状态条加高，卡片名称与细线字距正常，agy-3无会话说明已删除但输入和发送仍禁用；返回原“调用Antigravity工具说你好”总览/全部。真实任务、发送、新建、删除及改名0。4189份原文件核对4188份完全一致，仅重启host.lock变化，账号/历史/偏好保持；交付后活动仍0。实现提交7b523ab，未推送。

- OpenSpec 4/4任务按实际结果完成；worker-management主规格完整更新2块并增加无会话输入区1块，Purpose及其余8块和旧场景保持。同步后严格10/10；归档到openspec/changes/archive/2026-10-09-polish-worker-name-and-notice/后严格9/9、活动change0。本次交付及归档阶段提交，不推送。

## v0.7.6：简洁筛选区（2026-10-09）

- 已删除生成匹配说明及清除筛选的完整JSX和无用CSS，同步双语README。三类状态正向/空结果、搜索恢复、草稿保持回归通过：Panel59项，全套68文件/1307项通过、7跳过；Host/Client typecheck、严格规格10/10和preview通过。
- 隔离UI及正式Desktop交付按本次实际结果继续记录；不发起真实CLI、凭据查询或模型生成。

- 隔离原生UI实际核对13组筛选/搜索状态：三类正向、空结果及清空恢复；全部搜索正向/空结果与恢复，匹配数量/空结果说明/清除筛选均不存在，首卡与控件位置正常。最终Client hash与served一致，截图empty-filter.png已查看。独立HOME/DSH_HOME，临时Host/wrapper及自建页面已清理，真实CLI/生成/远端请求0；首次访问缺少临时token返回401，使用本服务临时URL后解决，不是账号阻塞。

- 正式交付：更新前22 Worker/活动0/账号或任务桥0，Desktop原生退出并确认主进程退出后正式build、pack及包核查通过。v0.7.6包共285文件，111源码与preview相同，Client执行内容一致；SHA-256 35a3f9c395d9aa3afae2ccbcf1dd0b763f7ee69ba2859a74a8288c1c14ffea4f，artifacts/dsh-cliworker-now-0.7.6-verification.json保存核查。
- Desktop原生插件页确认v0.7.6、启用及1组件运行；原会话三状态都没有匹配说明/清除文字，最终恢复原“进行中”视图，截图核对空白正确。原4210文件核对4208完全一致，仅重启host.lock及一份宿主session_projcache投影缓存检查点变化；已查rc.2原生SessionProjectionCache在会话释放时重写检查点的源码，原始日志/账号/历史/偏好文件保持，交付后活动0。未发送、新建、删除或改名任何真实任务，凭据查询和模型生成0。实现提交5d5b38c，本地不推送。

- OpenSpec 3/3任务均实际完成；主worker-management完整更新固定筛选需求1块，保留Purpose、其余10块及旧场景。同步严格10/10，归档到openspec/changes/archive/2026-10-09-simplify-worker-filter-view/后严格9/9、活动change0；交付与归档阶段提交，不推送。

## v0.7.6：npm预构建分发（2026-10-10）

- 用户本轮明确授权GitHub提交及npm公开发布。18个既有提交已正常快进推送main至86e4232，Windows native runtime CI成功（37952678662）；原未提交86项不进入push。
- npm官方网页登录由用户完成，仅临时私有userconfig保存；凭据不输出、不入Git。发布目录285文件、运行lib280文件与原已验收包一致，SDK peers/exports保留，根private:true、公开private:false、无消费侧脚本。node语法及3项隔离错误输入拒绝通过，npm发布dry-run通过；README短安装为发布候选，远端发布及实际安装仍按后续证据记录。

- GitHub公开v0.7.6 Release，完整commit741495a21cafe8952155739f06e24ad232e033d3；下载包与本地公开包一致，SHA256 654d5f128fd7aff6f24bb7e37a5cf4091461c77cdb322fb2572ce7f3acd20f7e。Windows CI 37956748796成功。独立profile实际GitHub URL安装/版本列表及全新Host graph通过，280 lib/19 helper一致，Agent/模型/CLI/账号查询0，服务18780已清理；这不是npm registry验收。
- npm官方登录已成功。首次发布EOTP；旧CLI大上传超时；npm12标准web流程和gzip传输均维持二次验证，gzip将首次PUT401响应缩短至4885ms，tarball不变。网页停在Security key，用户尚未完成安全密钥验证，各验证链接最终过期（done接口404）。registry对应包仍404；未重复覆盖已发布版本，临时userconfig和日志留在0700/0600私有目录且不入Git。
- 本次仅任务1.1实际完成。任务2.1的npm发布、2.2的registry实际安装及3.1的npm推荐/页面验收待账号安全密钥验证；活动OpenSpec保持，不归档或虚勾。GitHub README中英临时推荐使用已验证v0.7.6 Release URL，56字符npm短命令仅留私有候选，原131字符推荐不宣称已缩短。用户完成验证后继续相同公开包发布和registry验收。

- 2026-10-10续办：用户准备完成验证后，自动在同一PTY控制器中打开npm官方链接，安全密钥验证成功，普通publish返回PUT202；短时公开元数据仅占位0.0.0-stage而owner元数据已见0.7.6/latest。官方stage list和网页待审批均空；显式stage请求拒绝已有版本，未重复写入。随后匿名元数据更新为0.7.6/latest，匿名tarball下载SHA256/SHA512与GitHub相同，确认实际公开，不再误把CLI受理当公开成功。
- 公开npm0.7.6与GitHub Release共用同一包，SHA256 654d5f128fd7aff6f24bb7e37a5cf4091461c77cdb322fb2572ce7f3acd20f7e。独立无认证HOME/DSH_HOME/profile真实执行native add固定包名、native ls、全新Host图与退出：依赖和resolved来源为registry，280lib/19helpers全匹配，Agent/Worker/模型/CLI/账号查询0，端口18780及进程和锁清理完成，未改Desktop。证据install/install-verification.json和registry-cleanup.json。
- 中英README推荐改为56字符 dsh plugin --profile desktop add dsh-cliworker-now@0.7.6，原命令131字符，单行无上下备注，Web及GitHub备用保持折叠段。npm/root源码版本未改，原开发manifest仍private:true。前述待安全密钥事项已解除；后续页面核对与最终规格同步按实际结果追加。

- GitHub默认中文首页实际渲染推荐命令56字符，npm官方页面实际显示0.7.6、完整README及同一短命令，截图github-install-proof.png/npm-install-proof.png已查看。npm标题包含TypeScript图标替代文本，调整可访问名称匹配后核对成功，不将先前选择器超时当发布失败。Host/Client typecheck与严格规格检查通过；仅发版元数据/说明/打包脚本改变，运行lib仍与原已验包逐字相同，未再次宣称重跑1307项。

- OpenSpec四项任务4/4均完成，package-distribution主规格完整更新2块并保留Purpose/旧场景；同步后严格10/10，归档到openspec/changes/archive/2026-10-10-publish-prebuilt-registry-package/后严格9/9、活动change0。主页/包页、远端字节及真实registry profile安装均验证完成；本地提交并按本轮授权推送GitHub，原未提交修改继续排除。


## 2026-10-10：Mac 到个人 Windows 的隔离远程验收

- 用户授权接通 Windows 测试环境和流程；OpenSpec `add-windows-remote-test-workflow`，规划提交 `4c2d2e8`。新增 `scripts/windows-remote.mjs`、common/runner、27 项边界用例与 `test:windows:remote` 开发入口。中英 README 开发段和专用指南同步，安装区保持原单条命令；不新增运行时依赖或版本发布。
- 本机执行 `pnpm --config.verifyDepsBeforeRun=false typecheck`、新增测试 27/27、隔离 build:preview/pack、严格规格 10/10、git diff --check。现有回归在受限环境的真实进程用例失败并停滞，终止该次自身 Vitest 后用实际进程权限复查通过；完整回归 1300 通过、7 个权限夹具因本次命令 umask 077 不符而失败、7 个 Windows 专属跳过，标准 022 下两文件 44 项全过，合并核对 1307 通过/7 跳过。无产品/夹具源码改写。
- 实际命令：`pnpm --config.verifyDepsBeforeRun=false test:windows:remote --config .test-data/windows-remote/config.json`。Windows 11 x64、Node 24.15.0、固定 pnpm 11.25.0；专用 tools 非全局安装，SDK 与 Harness 0.2.0-rc.2 在本次依赖目录内，独立空配置执行 Harness --version 退出 0。
- 成功 run：冻结锁文件安装、归档列表/特殊文件核验、Mac 协议声明准备、类型检查、七个现有 CI 文件、原 Mac 包 Host 入口加载九阶段退出码全部 0。101 项通过、1 项明确 POSIX Pi launcher 场景跳过、0 失败；真实 Windows Job/取消、ConPTY、Python 用例通过，其余账号与 launcher 数据为合成夹具。Host 实际导出 CliWorkerService/default，在 Windows 本机 SDK 依赖中 import 成功。
- Mac/Windows 包 SHA-256 相同：`775bae13cb1dd5a1b1135be204ef5025de494f171ededd1a74d90d028dfc6b58`。报告、阶段日志及原始 Vitest JSON 回传，测试 JSON 哈希及计数/七文件/必要阶段/运行 ID 校验通过，正常运行两端锁释放并确认清理。
- 初次真实试跑分别暴露 PowerShell Get-Item 隐藏 AppData 需 -Force、gitconfig 文件误作目录、冷源码缺生成 remote 声明三项准备问题，逐项修正并保留失败/回传证据；最终成功不遮蔽这些记录。另在实际安装阶段主动 SIGINT：流程非零退出、两端 interrupted、报告回传、Windows 自有进程范围清理及两端锁释放确认。
- 私有证据在 `.test-data/windows-remote/runs/`、mac-regression-summary.json、cancellation-check.json、harness-version.json；原报告/日志/配置和个人机器信息不入 Git。最终 Mac 当前 lib 281 文件哈希与开始前完全相同，未正式 build 或更新 Desktop。模型调用为 0；官方 CLI 额外版本/帮助探针、真实模型、Windows 全量矩阵和 Desktop 界面均未验收，不以本次结果代替。
- 交付：实施提交 `b171f24`；OpenSpec 6/6 有实际证据，新增主规格 4 条需求，归档前后严格 10/10、活动变更为 0，归档到 `openspec/changes/archive/2026-10-10-add-windows-remote-test-workflow/`。只本地阶段提交，不推送；用户原有素材和文档改动保留。


## 2026-10-10：Windows 插件运行复验与实际 Harness 安装启动

- 用户要求在 Windows 重新跑插件测试。执行现有 `test:windows:remote`：Mac 当前隔离构建包上传、Windows 冻结本机依赖、类型检查、七个定向测试、原包 Host import 及证据回传均通过；101 通过、1 项已知 POSIX Pi launcher 跳过、0 失败。Windows x64 / Node 24.15.0 / pnpm 11.25.0。
- 补做真实 Harness 0.2.0-rc.2 验收：在本次 run 空 HOME/USERPROFILE/APPDATA/DSH_HOME 与管理配置目录中，使用原生 `plugin --profile windows-plugin-acceptance add --save-exact <Mac tgz>` 安装；原生 ls 退出 0，profile bundle 注册正确，安装后全部 280 个 lib 文件与 Mac 原包逐文件哈希相同。非用户 Desktop profile，无现有会话和账号写入。
- 在真实 web Host 内通过验收夹具读取 cliworker 服务及客户端 graph，注册、版本、客户端 bundle 哈希均匹配；Agent 和 Worker 为 0。夹具封锁真实生成、账号查询、外部 CLI 和外网 fetch，未把模拟对话或任务当成真实运行。
- 实际 HTTP 验收：认证根页返回 200，序列化 `globalThis["__DSH_BOOT__"]` 含插件；插件 JavaScript 返回 200，实际模块加载包装有效。向 `/api/cliworker/cliSettings` 发送缺少 parentSessionId 的请求，得到 HTTP 200 的 server-response 与预期 `gateway/arguments-invalid`，证明生成 endpoint 与参数校验注册正确，不将该错误响应写作真实任务成功。
- 首次私有验收夹具误用不存在的 ready 事件及字面 window.__DSH_BOOT__ 判断，分别超时/误拒真实正常 HTML；改用 appReady.onReady 与实际 globalThis 序列化形式后通过，未修改插件代码，各轮诊断保留。全部实例通过 Host 内 SIGTERM 正常 dispose，最终退出 0、fixture cleanup receipt 存在；再读 Windows 核对该 run 进程 0、18790 监听 0、host.lock 0、远程 run.lock 不存在。
- 报告和私有日志保存在 `.test-data/windows-remote/runs/` 对应 run 的 remote/ 与 harness/；连接令牌/Cookie 未输出或入 Git。当前结论仅为 Windows 安装、启动、插件注册/资源/Gateway及原生进程链路通过；真实 CLI 模型任务、账号权限和 Windows 原生 Desktop 画面未验证。模型调用 0，未更新 Desktop 或发布版本。


## 2026-10-10：实际 Windows Desktop 登录与功能验收

- 用户授权直接操作其实际 Windows Desktop，所有已登录且有额度的 CLI 沿用已保存模型做最小测试；MiMo 无默认值时单独明确选择 MiMo-V2.5/default。对象为 Windows 本机 DeepSeek Harness 0.2.0-rc.2 / 插件 0.7.6，不把此前隔离 Host 测试当成实际 Desktop 证据。
- 11 个 CLI 设置逐一检查。Kimi 本次原生终端登录、用户授权及刷新 authenticated 通过；Claude 识别已有 OAuth；两者模型目录仍拒绝确认自身账号，未执行真实任务；这涉及当前版本 OAuth 绑定/目录能力，尚不能归因为 Windows 特有故障。Antigravity 浏览器授权后未观测 CLI 完成，刷新仍未登录，且等待流程被本次验收关闭，需要完整复测，不能独断供应商失败。ZCode 管理终端启动失败；OMP 管理及登录立即退出；Grok 管理终端关闭后进程残留并阻塞后续登录。
- MiMo 模型目录、默认模型/强度保存、首次选型/角色卡、主对话派遣、过程与结果回传通过；首次任务真实创建测试文本，独立实读内容与哈希匹配。续聊保持同一原生会话，正确回忆文件名。两轮停止分别保留证据：提前停止未捕获运行前进程，不宣称运行中终止；另一轮在实际 UI 运行中且 MiMo/启动器进程存在时停止，三进程消失、状态 interrupted。Worker 无持久化 exitCode 字段，completed 按实现的退出 0/协议成功/退出确认判定并结合事件及产物核验。
- 实际 UI 通过临时角色增改删且原 7 个预设完全不变、MiMo 启用切换恢复、标题/名称独立改回、删除恢复同 Worker/native session、搜索及状态筛选、概览/子对话导航、运行时输入禁用。正常重启后会话和插件任务卡存在，模型偏好保存。未宣称注销重登、全部 CLI 真任务、跨项目继承、全部并发/权限/迁移路径完成。
- 实际安装包复现 Pi/OpenCode Windows launcher 拒绝而误报未安装，文件真实存在；Pi 已装 1.1.0 与插件只接受 1.0.2/1.0.4 是独立限制。Codex/Hermes 未找到可用 CLI，登录按钮禁用。没有重装 CLI、注销既有账号或修改产品代码。
- Grok 残留在正常退出整个 Desktop 后仍存在；核对本次 helper/父子关系后仅清理本次进程树。源码审阅发现外层账号弹窗关闭异步卸载并吞清理错误的恢复缺口，底层终止失败原因尚未确定。Desktop 已无调试参数重启，临时端口/SSH 隧道关闭、临时计划任务清空；测试会话和文本保留。
- 私有白名单结果、运行事件摘要、进程与截图证据及完整中文报告保存在 `.test-data/windows-remote/desktop-audit/`，不含凭据导出、不入 Git。此次只补充真实验收记录，不新建行为变更或发布；后续修复需单独按 OpenSpec 实施并复测，当前不判定全功能通过。

## 2026-10-10—11：Windows 登录修复与 MiMo 性能阶段验收

本段保留各阶段证据，当前结论以末尾最终 Desktop 复验为准。账号终端及 Antigravity 真实任务已通过；Claude 官方登录和 Kimi 额度边界仍单独保留，变更尚不归档。

- [x] Pi/OpenCode Windows 入口：实际 Windows 静态解析成功，Pi 指向官方 `@earendil-works/pi-coding-agent` 1.1.0 的固定入口，OpenCode 指向官方 npm 原生 exe。中文、引号、百分号、`&` 与空参数保持字面值。另用明确标记的模拟安装验证附加命令、错误包身份、损坏 PE、版本路径越界、未知版本及启动器改变均被拒绝。证据：`.test-data/windows-remote/launcher-fix/probe-result.json`、`rejection-result.json`。
- [x] Pi 1.1.0 原生契约：无凭据、无网络请求、无模型调用的实际 SDK/RPC 探针通过，包含 SDK 空会话/UI 方法、RPC `get_state` 与 `abort`、会话 ID 和退出码 0。原生登录菜单可显示并清理；该菜单被主动终止的退出码为 1，不能描述成完成登录。README 与设计文档已纳入 1.1.0，仍明确真实账号登录与模型任务未验收。
- [x] MiMo 能力缓存及隔离：仅在 Host 内存复用不含明文凭据的解析能力，30 秒、最多 16 项。账号、配置、项目、环境、入口及实际运行时/脚本变化使缓存失效；退出账号、取消和远端授权撤销不会因热缓存放行。实际 Windows 回归包含热缓存逐次重查远端模型权限、取消 paths/config/models、读取期间快照变化与失败不缓存等用例。
- [x] MiMo 真实元数据对比：同一 Windows、MiMo 0.1.15，旧实现三次为 6,899/5,267/5,085 ms，每次 3 个原生元数据进程；修复 Preview 首次未命中为 5,061 ms、3 个进程，随后命中 88/92 ms、0 个进程，解析能力均为 3 项。旧中位数 5,267 ms 对比热读平均 90 ms，元数据阶段约减少 98.3%。首次仍约 5 秒，不把此结果当完整任务耗时或服务端响应提速。证据：`.test-data/windows-remote/desktop-audit/mimo-metadata-benchmark.json`。
- [x] MiMo 实际 Desktop 完整目录：安装包 run `82132c8d-09dc-4c9e-acc6-b4e1736431c2` 后，首次目录查询 7,849 ms、连续热读 754/670 ms，包含当前账号及在线目录检查。元数据缓存 88/92 ms 与完整目录 754/670 ms 是不同测量范围，不混用。
- [x] MiMo 真实写文件：沿用原验收 Worker 与原生会话，使用用户明确选定的 `xiaomi/mimo-v2.5/default`。提交前检查 694 ms，queued→completed 14.723 秒，总计约 15.4 秒；协议 `SUCCESS`、持久状态 `completed`。原生首次写工具报错后自行修正，再次写入成功。读取实际 `cwn-windows-fix-82132c8d.txt`，内容等于 `WINDOWS_FIX_OK\n`，SHA-256 为 `FE1180B698337661D29E3314A13385EE1BD3A98532A28EF84A6D8336EC1C18A8`。不是只采信模型完成自述。
- [x] MiMo 同会话续聊：未再次提供文件名，原生会话正确回复上一轮文件名，协议 `SUCCESS`、状态 `completed`。提交前检查 7,320 ms（缓存已过期），queued→completed 7.154 秒，总计约 14.5 秒。前轮约 61/30 秒与本轮任务内容、会话缓存、网络条件不同，不能将全部差异归因于本次优化。
- [x] MiMo 运行中停止：实际启动 MiMo、启动器、PowerShell 等待及两个控制台，共 5 个按 PID/创建身份核对的进程；停止返回耗时 137 ms、状态 `interrupted`，同创建身份的五个进程全部退出。未按进程名称批量终止。完整目录、文件、续聊及停止摘要：`.test-data/windows-remote/desktop-audit/fix-mimo-live-summary.json`；人工核对说明：`Windows-修复与性能复验.md` 的“实际 MiMo 全链路复验”。这覆盖 Worker 停止；账号终端清理的独立验收见末尾。
- [x] 阶段自动回归：本地完整 Vitest 结果为 75 文件通过、1 文件跳过，1,488 测试通过、8 跳过，总计 1,496；原始日志 `.test-data/windows-remote/desktop-audit/fix-full-test-approved.log`，开始时间 2026-10-10 23:52:09。Windows 定向 `node node_modules/vitest/vitest.mjs run … --maxWorkers=4 --reporter=json` 覆盖 10 个测试文件，256/256 通过、0 失败、0 跳过；命令载于 `windows-new-regression-82132c8d.ps1`，最终原始报告为 `windows-new-regression-82132c8d.json`。中间 `*-platform-fixtures.json` 为 254 通过/2 失败，不能当最终通过报告。此阶段通过不覆盖其后的终端改动，最终源码仍需由主任务补回归结果。
- Claude 认证边界已纠正：旧验收把原生 `authMethod=oauth_token` 简称“官方 OAuth 已登录”不准确，实际令牌来自该 CLI 自身的本地代理设置。代理可连接时保持代理；关闭时使用临时原生官方配置，认证失败不切换来源。现有真实官方账号未登录，不能把代理认证或公共能力列表当作 Claude 订阅授权。原生 2.1.296 在未登录时也返回 5 个带 `resolvedModel` 的能力选项；controls-only 探针没有 prompt/模型事件，设置及凭据状态不变。新目录模块在真实 Host backend 下正确拒绝未登录。`get_usage` 可以使用 CLI 自身按账号绑定、年龄小于 60 秒的快照；插件不新增额度缓存，并拒绝缺少原始 limits 的失败 fallback。正向官方登录与任务仍未通过。证据：`.test-data/windows-remote/claude-route/native-route-safe-result.json`、`overlay-isolated-result.json`，以及 `.test-data/windows-remote/oauth-research/claude-readonly/native-control-safe-result.json`、`claude-native-module-result.json`。
- Kimi 当前真实限制：原生 TUI 已自行续期，随后同源 `/models` 返回 HTTP 200 与 4 个原生别名对应模型；`/usages` 返回 HTTP 200、完整空对象 `{}`。官方原生界面对空套餐窗口显示无用量信息，不能解释成无限额或断言用户没有订阅。插件提示剩余额度无法确认并拒绝派遣，不绕过门槛、不手工刷新令牌，不宣称真实模型调用通过。仅确认默认强度。证据：`.test-data/windows-remote/oauth-research/kimi-preview-after-native-refresh.json`。
- [x] Windows 账号终端：实际 Desktop Electron 控制台归属、窗口关闭及后代清理的最终修复和现场验收通过，详见末尾；模拟回归、Node 探针或 Worker 停止不替代该验收。
- [x] Antigravity：实际 Desktop 原生 Credential Manager 账号状态和真实模型任务均有独立证据，Gemini 3.8 Flash Low 文件任务的事件、结果及产物见末尾。
- [ ] 最终集成交付：最新源码完整回归、最终 Desktop 包与源码一致性、活动进程清零、规格严格校验和阶段提交以主任务最终记录为准；OpenSpec 按实际子项记录，Claude/Kimi 边界保留，不归档、不推送。

私有日志与运行证据保留在忽略目录，文档仅记录可核查的结果和边界，不提交凭据、账号原文或用户运行数据。

### 最终安装与 Windows 原生终端复验（2026-10-11）

- [x] 最新源码类型检查及完整回归：1,505 通过、8 跳过；Windows Electron 专项 94/94，覆盖真实三路 TTY、输入、Unicode/空串/引号/元字符参数、停止、自然退出码 7、后代及控制台回收、61 秒后终态关闭与失败重试。仅生命周期夹具明确标为模拟，不冒充模型调用。
- [x] 最终 run `2b637e3f-54b7-4f9f-991d-19709bd62416` 的 Windows 类型检查、107 项通过/1 项 POSIX 专用跳过、原 Mac 包 Host 加载通过；源码与 preview 核对、清理和锁释放确认。
- [x] Windows 无活动 Worker 时正常退出 Desktop，使用安装版自身 `runtime/cli/bin/dsh.cmd` 更新；308 个 lib 文件与包一致。包 SHA-256 `2d9056b725d1d0b9c35468f0ce096df8c7f9a3f8b9ab9897ece0f752061d3a4f`；Host SHA-256 `aaf3205ef88ded62cafd22f7b88b8b2c5958c1827e68c56f62c8a9e98177b1b5`。Mac 正式构建后恢复应用，Host 哈希相同。
- [x] 真实 Windows OMP 输入 `/login` 显示提供商菜单，黑色块状光标与焦点边框可见；外层关闭无错误，三个已记录 PID/创建身份均退出。Pi 1.1.0/OpenCode 原生认证菜单、ZCode Z.AI 登录提示、Grok 原生授权入口均能打开、获得输入焦点并正常关闭。未提交新账号凭据或退出既有账号。
- [x] 根因修复以实际 Electron 为准：固定 PowerShell 等待 GUI helper；账号专属 `CONIN$` 恢复输入，仅预加载本次 Electron CLI，不改共享 Host/任务输入。`cleanupConfirmed` 仅在全范围及私有资源释放完成后发出，修复终态过期后关闭误报。
- 派遣路由增量 81 项通过：排除插件/工具说明，归一同 CLI 括号别名和重复指令；未知/不同目标仍拒绝。实际 Antigravity 派遣成功见下一节；Claude 原生进程虽启动，但终端空白，尚不确认官方登录流程正常。
- 证据为 Git 忽略目录 `.test-data/windows-remote/desktop-audit/` 中 `final-full-test.log`、`windows-electron-final-regression.json`、`electron-host-final-tty-result.json`、`final-install-result.json`、`final-desktop-ui-summary.json`、`final-omp-cursor-input.png`。前述中间包失败作为历史保留，以本段及后续记录为当前结论。

### Antigravity 真实最小任务通过（2026-10-11）

- 用户明确选定 Gemini 3.8 Flash、Low；在专用 Windows 验收聊天通过真实插件选型，未附加角色预设。原失败句含 `CLI Worker` 与 `Antigravity（agy）CLI`，更新后成功进入选型和执行。
- Worker `ba82f9d8-a2ac-419f-b6ff-aea6b74a32f0`，run `91a5c33f-9c9c-441f-b91d-988008a22526`，原生会话 `a7763d79-f6d3-4ec6-8ddc-4883e6d3ea24`。原生选型 ID `gemini-3.8-flash-low`，思考强度 low。queued 到 completed 约 22.0 秒；事件包含 write_to_file DONE、result SUCCESS 和最终 completed。
- 实际 `cwn-windows-agy-fix.txt` 的内容严格等于 `AGY_WINDOWS_OK\n`，SHA-256 `57FF6AF8ED1A0D68189F378DCD137658D6E57CD1AAE2D2FE80F1FC23760B0F0C`。独立读取核对，不以模型自述代替验收。证据 `final-agy-worker.json`、`final-agy-events.jsonl`。
- Claude 仍单独待验：官方登录进程已启动并监听本地回调端口，但真实 xterm DOM 无输出（非 Canvas），尚未确认浏览器授权页面或账号登录成功；不据此宣称官方登录全链路通过。

### Claude 官方登录对照与重试（2026-10-11）

- 已结束先前空白终端，三个精确归属进程均退出。同一已安装 helper/Electron Host 的 `--version` 正常输出 2.1.296、退出 0；`auth status --json` 的内联 JSON/私有配置文件对照均正确识别官方未登录、退出 1，清理确认，未启动模型。
- 相同官方配置的 Windows 原生可见控制台出现完整浏览器/备用链接/回填码提示，随后仅清理该次进程和非秘密临时配置。没有据此认定已经登录。
- 实际插件再次启动，恢复 Desktop 窗口前台后已看到上述三项提示，xterm 输入聚焦，未显示登录错误；源码/安装包未变。首次空白时未确认窗口可见性，不能据此断言 CLI OAuth 挂死或 stdin/stdout 故障；准确原因仍未确定。当前等待用户完成官方授权，未计为 Claude 真实模型通过。
- 安全证据：`claude-version-probe-result.json`、`claude-status-inline-file-result.json`、`claude-native-console-control-result.json`、`claude-desktop-login-retry.json`；仅保存固定提示布尔值、身份及退出结果，不保存授权 URL/验证码。

### 阶段交付与待用户授权

- 已本地提交 `d416b44`、`db5d9a7`，未推送、未发新版本。当前安装包与最终源码对应；严格规格 11/11 通过。原有素材移动及文档改动未混入提交。
- 实际 Windows 三个 Worker 均已结束（两个 completed、一个 interrupted）；本次临时 UI 计划任务为 0。当前只保留用户待授权的 Claude 账号终端，故不重启 Desktop 以免取消授权。正式关闭账号终端及恢复无调试参数启动仍待后续完成。
- 修正首次空白的证据解释：xterm 6 的 DOM 绘制与输出缓存分离，不可见时可推迟刷新，空 DOM 行不能证明没收到输出；同代码恢复前台后已显示完整提示。首次现场缺少可见性/缓冲证据，不断言具体根因。账号授权与模型执行仍以真实成功状态核对。
- Claude 官方账号授权需用户完成；Kimi 同源额度响应为 `{}`，没有可核验剩余额度，继续保留未验收边界。其余已完成的 UI、MiMo 文件/续聊/停止、Antigravity 文件任务和自动测试不受影响。OpenSpec 保持活动，不通过归档隐藏缺口。

- 已关闭本次 Mac→Windows 调试 SSH 转发，Mac 19487 监听为 0；Windows 当前登录终端继续等待用户操作，应用的本机调试参数将在账号终端结束后正常重启清除。

### 用户跳过 Claude 官方调用后的收尾（2026-10-11）

- 用户明确没有 Claude 官方账号或额度，要求跳过真实调用；不再要求其完成官方授权。保留已有代理/原生官方来源选择规则及登录入口验证结果，不将“已显示授权提示”记成官方登录成功或模型执行成功。本轮没有发起模型调用或新的登录。
- 实际待授权终端窗口已关闭，外层设置退出；原账号 scope 已释放，不按旧 PID 操作后续复用该编号的进程。三个 Windows Worker 全为终态，活动数 0。通过应用自身退出菜单关闭旧调试实例，随后无调试参数正常启动 Desktop。
- 收尾实测：旧 GUI/Host 已退出；Windows 19487 监听为 0；ready 账号 scope 为 0；临时 UI 计划任务为 0。新的 Desktop 已运行且无 remote-debugging 参数；Mac 本次 SSH 转发已关闭，19487 监听为 0。未退出用户已有账号或修改代理设置。
- 安全证据：`.test-data/windows-remote/desktop-audit/claude-skip-final-cleanup.json`。Kimi 的同源额度未知仍单独保留；Claude 官方正向账号/模型验收按用户要求跳过，OpenSpec 保持未验收边界，不归档。


### 共享终端精简与 Windows 追加回归（2026-10-11）

- [x] 按用户追加要求删除所有账号终端粗黑外框、粘贴按钮、单独的网页登录按钮及底部粘贴快捷键小字，Mac/Windows 共用同一 React/xterm 实现。Windows 实际 focus outline 为 none，终端仅保留关闭按钮；Mac Pi 1.0.4 新版终端同样无多余控件、中文系统粘贴可见，未回车提交模型。Mac OMP 18.4 提供商搜索未显示粘贴文字，Pi 的相同共享通路成功；未将该菜单差异当成共享粘贴失败或宣称原生 CLI 所有菜单均兼容。
- [x] Windows OMP 18.8.7 实际 Ctrl+V 中文只进入一次。双击形成真实 xterm 选区后，以原生 Ctrl+C 复制，系统剪贴板与受控中文字符串精确一致，终端保持运行；无选区 Ctrl+C 仍进入 CLI 原生中断流程。原剪贴板只在 Windows 临时内存保留且恢复，未导出。右键粘贴在同源共享输入改动的前一安装包已实测，最终版复制/右键分支及迟到读取另有定向回归；不以模拟键盘逐字输入替代系统粘贴验收。初次自动拖拽未形成选区，原因未确认，以实际双击选区复制结果为准。
- [x] ZCode 0.16.9 根因实证：原生终端网址有 client_id/redirect_uri/state/response_type，旧 Windows 浏览器仅收到 client_id。修复后登录自动打开 chat.z.ai/auth 正常登录页，四个参数名齐全，无错误提示；终端原网址悬停为 pointer，点击重新打开也保持四参数。保留原生授权轮询，关闭后清理；本轮未完成账号授权，不把网页正常当成登录成功。证据不记录 URL 参数值。
- [x] Codex 官方 Windows Store 固定入口真实版本 0.162.0-alpha.17.2；插件 installed=true、authenticated 且 verification=cli，Desktop 显示已登录，原生账号终端出现 OpenAI Codex 和输入提示，关闭无异常；本轮没有提交模型任务。
- [x] 用户批准的 Hermes 官方原生安装完成，固定提交 c57331677d7fc46298a7159cf3a650853f0966c5，版本 0.21.6+607.gc573316，version 命令退出 0；官方安装 receipt 标记 success，未安装可选浏览器/计算机控制依赖。安装器 GUI wrapper 没有可靠进程退出码，不能据此声称安装器 exit 0。实际 Desktop installed=true、unconfigured。
- [ ] Hermes 原生登录终端实测发现隔离 home 下依赖选择缺失，提示 no dependency environment is committed；正在把 Windows 入口接入已有依赖 pin 流程。安装完成/版本命令正常不等于登录终端完成，待后续证据补齐。
- [x] 最终共享终端代码全量 1627 passed/8 skipped（81 文件通过、1 文件跳过）；Windows 实装 Electron(asNode) 专项 10 文件，189 passed/2 POSIX-only skipped/0 failed，进程退出 0。原默认沙箱完整测试挂起，按本轮 PID/创建身份清理后授权环境重跑通过；不将首次挂起解释成业务测试失败。类型、严格规格 11/11、隔离 preview 与 Windows run 2c16676d-21c6-4bb6-b5b7-e780a8430cb3 原包加载通过。
- [x] 两端无活动 Worker 时更新：Windows 使用原生安装器，唯一文件名避开同路径 tarball 缓存，317 个 lib 文件与包逐项匹配；包 SHA-256 92dea5e01532a40072189ab7eb2dd217d34e40698ec19d8204373f1be8ffef46。Mac 正式构建并重启，实际新版 Pi 终端验收通过；账号终端已关闭。最终 Windows 无调试重启与 Hermes 后续包另行记录。
- 私有证据：terminal-ux-live-safe.json、terminal-ux-windows-final.png、terminal-ux-final-tests-approved-results.json、windows-electron-user-terminal-2c16676d-utf8-summary.json；位于 .test-data/windows-remote/desktop-audit/。Hermes 安装回执位于同级 hermes-install-review/。既有 Claude 官方账号/额度跳过、Kimi 额度未知等边界保持；未推送、未归档。


### Hermes Windows 依赖修复与本轮最终交付（2026-10-11）

- [x] 修复上一阶段待办的 Hermes 隔离账号目录依赖定位：共享 Mac 的已提交官方 venv/lease 机制，Windows 仅补充固定 distlib/cmd 入口解析和原生文件锁。6 项新测试覆盖合法入口、拒绝伪造/不一致记录及环境边界；没有启动 bootstrap 或复制其他账号凭据。
- [x] Windows 实际 Desktop 最终包显示 Hermes 提供商菜单、`Choice [default 1]` 和 Leave unchanged，无 `no dependency environment` 或 traceback。后续原生流程显示 Nous Portal 网页授权提示；未完成授权，已取消账号终端并关闭本次临时网页。Hermes 当前仍未配置账号，本轮没有模型调用。安全记录只保留状态/提示布尔值，不保留授权码截图。
- [x] 最终本地完整回归 1633 通过、8 跳过、0 失败；类型检查和隔离 preview 通过。最终 Windows run `ae2dbcd8-0777-4780-a25b-461089dfe5c4`：类型/Host 加载通过，基础测试 107 通过、1 项 POSIX 跳过；实际 Desktop Electron 11 文件专项 195 通过、2 项 POSIX umask 跳过、0 失败，进程退出码 0。模拟协议测试与实际界面证据分开，不将其计为全部 CLI 真实模型成功。
- [x] 在活动 Worker/账号终端均为 0 时安装最终包：SHA-256 `14f8d8f258220d5846dcd9a9598905a8ab32979b45acc6ca7c76c5113c4d7d01`，Windows 320 个 lib 文件与 preview 包逐项一致。Mac 正式构建 Host 与该 preview 相同并已正常加载。共享 UI、ZCode 四参数自动/手动网页链接、Codex 原生账号终端的上一阶段实证继续有效，详见上节。
- [x] 首次最终远程测试 `fd6e9167-9c46-4523-aafe-d8a60d3f041b` 因 C 盘空间耗尽失败，原始失败报告保留。仅清理本任务 owner 标识且进程已退出的构建依赖缓存后重试通过；最终 run 又清理约 0.82 GB 可重建依赖，887 个源码/产物/证据文件前后哈希一致，保留 2c16676d 备份依赖。未清理用户数据或 Hermes 安装，收尾磁盘空闲约 7.02 GB。
- [x] Windows 已无调试参数正常启动；Windows/Mac 19487 监听均为 0，账号 ready scope、临时 UI 计划任务、活动 Worker 均为 0，三条历史 Worker 记录保留。证据：私有 `.test-data/windows-remote/desktop-audit/hermes-final-{live-menu,install-result,cleanup}.json`、`windows-electron-final-hermes-ae2dbcd8-*`、`final-run-dependency-cleanup.json`，不入 Git。
- 边界仍保留：ZCode 仅证实网页登录正常，未完成授权；Hermes 原生安装和登录终端可用，尚未配置账号；Claude 按用户要求跳过官方账号/真实调用，Kimi 同源额度仍不可核验。OpenSpec 3.1/3.3 继续未勾选，不通过归档掩盖缺口。阶段提交，不推送。


### Windows 模型目录、首次检测和加载优化（2026-10-11）

- [x] 修复 Pi/OMP Windows 目录 fchmod EPERM。实际 Windows Desktop 读取 OMP 11 个模型、Pi 2 个模型；界面下拉分别按模型显示原生强度（Pi GLM-5.3 为 Low/High/Max）。OMP 重新打开设置实测从“正在读取登录信息”约 1.376 秒进入已识别状态，没有误报未安装；原始首次误报本轮基线未复现，不能据此声称确定了所有首次检测失败原因。
- [x] Codex Windows 原生 app-server 返回 6 个受支持模型及强度，远端额度响应 allowed=false/limit_reached=true。实际界面改为“Codex 当前账号额度已用尽，请等待额度恢复后刷新”；没有伪造可用模型，也没有消耗模型额度。
- [x] OpenCode 两条原生启动路径显式隐藏额外控制台。实际 45.084 秒窗口观察覆盖模型读取、刷新、登录启动，新增可见控制台为 0；嵌入式原生 Add credential 菜单显示正常，方向键选项移动成功，关闭后账号终端退出。基线 45 秒也未复现用户描述的窗口，参数回归和修复后观察不能证明所有短暂闪窗已被捕获。
- [x] 设置页账号检测以当前项优先、最多两个请求并发，取消/重新启用/过时结果回归通过；Kimi/Claude 能力复用与账号/入口/配置变化、失败、取消安全边界回归通过。Antigravity 同一目录查询减少一次 Windows 身份读取；当前实测 6.394/6.147 秒、均为 7 个模型，旧观察 10.847/11.707 秒仅作参考，网络及系统负载不同，不据此计算固定加速比例。
- [x] MiMo 保留既有有界能力复用，当前同一账号连续读取实测 10.311 秒→0.262 秒，均为 2 个原生模型。旧包已可 6.572 秒→0.277 秒热读，因此这不是本轮新增的冷启动加速；本轮没有改变原生串行初始化，也不承诺全部 CLI 首次秒开。
- [x] 追加成功目录回收：旧 OMP 每次成功查询留下约 121 MB 临时目录。最终包实机连续 OMP→Pi→OMP→OpenCode 返回 11/2/11/5 个模型，耗时 7.591/1.567/5.748/2.784 秒；查询前后对应目录完整名称集合和计数一致（15/8/11），新成功查询均已移除，旧失败现场保留。
- [x] 自动验证分阶段保留：主要修复本地 1696 passed/8 skipped；Windows 实际 Electron 20 文件 366 passed/1 POSIX-only skipped/0 failed，Host 加载和两端类型通过。随后目录回收补丁定向 5 文件 90/90；最终本地完整 89 文件、1702 passed/8 skipped/0 failed，类型、preview、正式构建和严格规格 11/11 通过。Windows 366 项属于追加回收前的包，最终追加补丁使用前述真实目录与回收验收，未虚称重跑全部 Windows 单测。
- [x] 本地默认沙箱完整测试因 detached-child fixture 进程控制限制挂起；按本次 PID/创建身份结束两个测试进程组后，允许进程控制的环境完整重跑通过。Windows 一次合成 OMP worker SQLite 路径达 271 字符，缩短隔离 TEMP 后同测试 6/6 及 20 文件回归通过，未更改生产数据库路径来伪造通过。
- [x] 最终 preview 包 SHA-256 `d88f9a0d88c11ec905c062ffc205a47e324e864215930e952e122b0d7c02bd8b`，无活动 Worker/账号终端时使用 Windows 原生安装器更新，326 个 lib 文件逐项匹配。Mac 正式构建 Host SHA-256 `1d7db6ac0836fe95247ced4bb762f7dd09302a876d8cfcd87b19eeb3698cf685` 与 preview/Windows 一致；Client 仅构建路径注释及 source map 有差异，执行代码相同。Mac 共享设置实际渲染 Pi GLM-5.3 的 Low/High/Max 下拉正常。
- 环境干扰已核查：一次 OMP 重读失败时 C 盘空闲为 0。此前远程验收的 agy models PowerShell 孤儿进程占约 55 GB 私有内存；核实确属本任务脚本后结束，确认退出，分页文件自动缩小，空间恢复约 26 GB。同一个未更改的插件包随后 OMP→Pi→OMP 全部成功。仅清理本任务可重建依赖/native 缓存，保留报告和哈希；未清理用户数据、账号、安装或修改分页设置。不能把这一环境故障当作账号问题或本次代码回归。
- 证据保存在 Git 忽略的 `.test-data/windows-remote/desktop-audit/`：`models-windows-accepted-report.json`、`models-cleanup-local-full-approved.json`、`models-after-*.json`、`omp-after-first-detection-ui.json`、`opencode-console-after.json`、`opencode-after-terminal-ui.json`、`models-final-live-repeat.json`、`models-query-cleanup-verified.json`、`models-cleanup-install-result.json` 和下拉画面。仅记录安全模型能力、计数、耗时及状态，不保存授权码或令牌。
- 边界：本轮真实模型调用为 0；Kimi 当前凭据已过期，未验证正向账号热读；Claude 官方账号/额度按用户要求跳过，历史 OpenSpec 3.1/3.3 保留未勾选，不归档。ZCode 继续官方默认流程。此阶段本地提交、不推送。
- [x] 收尾：Windows 已无调试参数正常启动，Windows/Mac 19487 监听为 0；账号 ready scope、临时 UI 任务及任务归属 PowerShell 为 0；3 条历史 Worker 为 interrupted/completed/completed，活动为 0。Mac 最终正式包已正常加载，当前无登录终端。清理结果见 `models-final-cleanup.json`。


## 2026-10-11 ZCode 国内/海外授权选择与后台终端窗口复核

- [x] 按最新要求增加 Mac/Windows 共用的“中国智谱 BigModel / 海外 Z.AI”原生登录选择。选择前不创建终端，关闭后重置；Host 单独验证 ZCode/login/provider，旧 Host 明确提示更新，不回落到另一来源。既有原生账号、项目偏好及凭据未迁移。
- [x] Windows Desktop 附带的 0.16.9 仅声明 Z.AI；官方完整 CLI 同版本号支持 `login [zai|bigmodel]`，不能只看版本判断。部署官方完整源树 `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 和对应 Windows x64 原生依赖到插件 managed runtime，3,872 个文件哈希核验通过。完整运行时 ZIP SHA-256 `28930bcb9fcc6689ed28a78f488974d63f60eb286582e5c71e8101aab3e94be4`；没有覆盖 ZCode Desktop。
- [x] 实际 Windows 两选项分别打开 `bigmodel.cn/login` 和 `chat.z.ai/api/oauth/authorize`（原生跳转 `/auth`），原始参数完整，URL 不写入报告或 Git。中国授权等待用户交互期间原生 CLI 先退出，未获授权完成确认，未判断具体退出原因；海外入口核验后主动关闭。两者均不计作账号授权成功或模型执行通过。Mac 实际共享选择界面和选择前取消已验证，原账号保留。
- [x] 插件普通后台进程统一 GUI bootstrap + `windowsHide` + 独立 stdio 管道，修复只隐藏包装进程、继承数字 fd 导致缺少 CREATE_NO_WINDOW 的路径。独立原生退出回执与 SDK Job 的范围退出分离，真实 CLI 退出后仍持有输出的后代必须确认清理。未修改 Harness 核心、ConPTY 技术栈或用户默认终端设置。
- [x] 最终源码完整测试 90 文件通过、1 文件跳过，1,788 passed / 8 skipped；Host/Client typecheck、preview 与严格规格 11/11 通过。Windows 实际 Electron 44/SDK Job 合成验收 9/9：参数及环境保留、二进制 stdin、分离输出/非零退出、收集输出、每路 2 MiB 背压/EOF、提前退出关闭输入、ENOENT、停止/取消 detached 后代，以及经 private launcher 的自然退出但后代仍持有管道；无 Job 降级，所有范围退出、无残留 fixture PID。合成测试不冒充真实模型调用。
- [x] 无活动任务时经 Windows 原生插件安装器更新最终 preview 包，334 个 lib 文件逐项匹配，包 SHA-256 `ec0657cc5c1b61d42b3437440dfcda1f13ebd8088f7bc707a06f0befeed69817`，Host SHA-256 `96b9150e58639a1da318ee4597a615376a20b11824ad45edee9a2189341d419f`。早期验收清单误含构建缓存 tsbuildinfo 时校验拒绝；后续清单对实际打包内容重建并通过，保留失败记录。
- 窗口观测保留方法边界：最早 PowerShell 观察器启动可能引入自身窗口；改为 GUI 子系统、CreateNoWindow 启动。v3 的 PID 单值父链会受编号重用影响，不能用于归属；其全局窗口 SHOW 事件仍有效，其中一轮 150 秒观察有一次未解释的可见 Windows Terminal。v5 改为进程创建/退出时间和 PID 实例关联，保留全量进程名与时间，不记录命令行/原始窗口标题。最终结果及边界见后续追加。
- 本轮真实模型调用为 0。实际目录刷新中 Codex、MiMo、OMP、Pi、OpenCode、Antigravity 模型及强度控件可用；Claude 无官方账号/额度、Kimi/Hermes 账号过期、Grok 未配置、ZCode 授权未完成的边界如实保留。历史 OpenSpec 3.1/3.3 不勾选，不归档。
- Mac 已验证本轮 ZCode 共享 UI，但最终 Windows pipe 补丁的根目录正式构建尚未更新：Mac 锁屏，无法通过应用菜单正常退出 Harness，已请求解锁；未在宿主运行期间覆盖链接包。此项不计为两平台最终安装完成。
- 私有证据位于 `.test-data/windows-remote/desktop-audit/`：`zcode-console-acceptance.json`、`zcode-provider-ui-evidence.json`、`windows-hidden-process-pipes-result.json`、`zcode-console-pipes-tests.log`、`zcode-console-pipes-typecheck.log`、`zcode-console-pipes-spec.log`、最终包与逐文件清单、v3/v5 窗口和动作时间报告。
- 最终 v5 实机观测：已运行实例重开设置并刷新全部 11 个 CLI，120.906 秒窗口事件为 0；再次正常重启后首次打开设置、全部 11 个 CLI 刷新、OpenCode 原生 Add credential 登录菜单和关闭，141.629 秒窗口事件为 0，hook 均确认结束。两轮动作 UTC 与报告对应；这两次通过不抹去前述 v3 未归属事件，不宣称所有系统状态下绝无闪窗。
- [x] 收尾：Windows 正常无调试参数启动，两端 19487 监听为 0；账号 ready scope、观察器/临时 UI 计划任务、本轮 PowerShell 和 GUI launcher 均为 0，3 条既有 Worker 状态仍为 interrupted/completed/completed，活动 Worker 为 0。清理证据为 `zcode-final-cleanup.json`；阶段提交仅包含本轮代码/规格/新增记录，不包括用户原有图标及文档改动，不推送。


### ZCode BigModel 授权与两平台最终构建收尾（2026-10-11）

- [x] 用户确认已完成 BigModel 网页授权后，对 Windows 生产安装插件做只读核验：状态为 authenticated / oauth / local，当前来源与终端保存来源均为 bigmodel，原生 BigModel 绑定存在；读取前后凭据摘要未变化。由此确认授权已落盘且插件能够识别，不推断远端额度或真实任务成功。Z.AI 仍只有原生入口及网页跳转验证，本次没有退出账号、重新登录或模型调用。
- [x] 用户确认早期窗口观察期间手动打开过终端或运行命令。此前 v3 有效 SHOW 事件保留为“人工操作干扰期内、来源未证实”，不强行归属用户或插件。最终 v5 热态 120.906 秒、冷态 141.629 秒均无额外控制台事件，动作覆盖设置、全部 11 个 CLI 刷新及 OpenCode 原生登录菜单关闭；以此完成本次已执行路径和观察时段的验收。已定位的插件后台启动路径已修复，不宣称所有第三方 CLI 在所有环境下绝不创建窗口。
- [x] 用户解锁 Mac 后，确认 22 条既有 Worker 均为终态（18 completed、3 failed、1 interrupted），活动数 0；通过原生界面正常退出 Harness 后执行 `pnpm --config.verifyDepsBeforeRun=false build`，退出 0，再正常打开 Desktop。正式 Host SHA-256 为 `96b9150e58639a1da318ee4597a615376a20b11824ad45edee9a2189341d419f`，与 Windows 最终验收包一致；三个启动 helper 的 source/lib/preview/types 文件分别一致，Client 除构建路径 region 注释外完全相同。
- [x] Mac 最终实际界面显示 ZCode 已登录、模型与强度控件可用；点击登录后显示中国智谱 BigModel／海外 Z.AI 共用选择界面，选择前未创建账号终端，取消后保留原账号，最后关闭设置。Windows 本次仅只读核验授权，未再次启动调试实例；前一阶段的无调试重启和清理证据继续保留。
- [x] 本次正式构建、实际 UI 与授权核验、差异检查通过；`pnpm --config.verifyDepsBeforeRun=false spec:check` 为 11/11，OpenSpec 本次 9.2/9.4 完成。源码未更改，完整 1788 passed / 8 skipped 与 Windows 合成生命周期 9/9 为前一实现阶段结果，本次没有重复运行或新增模型调用。历史 3.1/3.3 的 Claude 官方账号/额度跳过及 Kimi 验证边界继续保留，change 为 28/30，不归档。
- 私有证据：`zcode-bigmodel-auth-verified-20261011.json`、`zcode-mac-final-build.log`、`zcode-mac-final-equivalence.json`、`zcode-mac-final-ui-verified-20261011.json`、`zcode-console-final-followup-20261011.json`，均在 Git 忽略的 `.test-data/windows-remote/desktop-audit/`。此前授权未确认及 Mac 锁屏是历史时点状态，由本节补齐；原报告保留。仅阶段提交本次验收记录，不混入已有文档/素材改动，不推送。


### Hermes Nous 登录续期修复与双平台验收（2026-10-11）

- [x] 确认共同缺口：插件在 Nous 短期 invoke JWT 到期前 120 秒及到期后拒绝目录/任务，但没有让已保存的原生刷新凭据续期。Windows 当前原生访问令牌寿命为 3,600 秒；诊断时两端访问令牌仍有效，没有伪造过期现场。已有登录之后的陈旧 terminal error marker 不再单独否定仍有凭据的账号。
- [x] Mac/Windows 共用 `hermes-renewal` 与固定原生 Python 入口，状态、目录、任务绑定和直接准备均接入；健康状态无额外子进程。短期令牌允许同账号自动续期，网络/服务暂时异常保留登录并允许刷新重试；明确失效或缺少续期凭据才要求重登。主体、组织、client、路由不猜测，外部账号、guest、登录网页和模型生成均不进入续期路径。
- [x] 续期并发合并，账号操作与最后订阅取消等待有限原生事务落盘和完整范围退出。原生 auth→shared 锁内重核 source/pool；轮换回调先保存，再做后续原生有效性检查。只同步认证字段，保留池 ID、标签、优先级、停用、额度及冷却；同主体较新 shared 可以采用，身份不符及同到期但不同链拒绝。
- [x] 最终 Host/Client typecheck、完整回归 1,847 passed / 8 skipped（93 文件）、`build:preview` 通过。新增合成用例覆盖过期/临近过期、状态集成、稳定任务绑定、并发取消、账号终端互斥、轮换后失败仍保存、共享来源校验、额度冷却、私有入口及实际解析器依赖。初次 Mac 原生验收揭示 PyYAML 缺失，改为官方 `hermes_yaml` 并补无 PyYAML 回归；失败报告保留，最终实机结果见下。
- [x] Mac 已安装 Electron 44 + 宿主 SDK 实测原生续期：2026-10-11 07:05:18–07:05:21 UTC，1,070 ms 返回 ready/exit 0，访问与刷新令牌均真正轮换，剩余有效期 1,433→3,599 秒；主体/任务绑定及池元数据不变，provider/pool/shared 一致。健康状态再次检查 0 子进程；实际目录 11 模型、4 模型支持显式强度、8 种强度，1,236 ms。SDK 有一次 Mac 原生平台既有 containment fallback 提示，正常退出已确认，不冒充 Windows Job 级隔离。
- [x] Windows 已安装 Electron 44 + 真实 SDK Job 在交互会话实测：2026-10-11 07:10:35–07:10:39 UTC，2,085 ms 返回 ready/exit 0，访问与刷新令牌均真正轮换，剩余有效期 487→3,600 秒；主体/任务绑定及池 ID/元数据/数量不变，provider/pool/shared 一致。健康状态 0 子进程；真实目录 11 模型、4 显式强度模型、8 种强度，1,761 ms。仅 1 个受管进程范围，全部退出，SDK 无降级。v5 交互桌面观察覆盖此次动作，90.582 秒 windows=0，hookStopped=true。
- 真实验收使用仅子进程生效的提前续期阈值触发一次官方 refresh；没有修改用户配置、系统时间或伪造真实令牌到期。过期及并发场景由明确合成夹具验证。两端登录调用 0、模型任务 0；目录成功不代表真实生成通过。
- [x] Mac 确认 22 条既有 Worker 的活动数为 0、账号/任务桥进程 0，通过应用菜单正常退出后正式构建再启动。Host SHA-256 `f775fa7d4815c5ca3e00c0481c05f12636494e76561eac1dfa20596ba131d23d` 与 preview 一致；四个关键 helper 的 source/lib/preview/types 一致，Client 仅构建路径 region 注释不同。实际设置显示 Nous 已登录、模型下拉和强度控件可用，刷新后仍正常，未保存更改模型，最后关闭设置。
- [x] Windows 确认活动 Worker/账号终端为 0，正常退出后经原生插件安装器部署最终 preview 包，exit 0，339 个实际打包 lib 文件逐项匹配；包 SHA-256 `aba632b0049ad9eb844acb2a10297478730a93460f1bae59c1f45fcf93d6b3fd`，Host 与 Mac 正式构建相同。正常重启后真实设置显示 Nous 已登录、11 项模型及当前模型 3 项强度，状态刷新正常，最后关闭设置。
- [x] 最终 Windows v5 观察完整覆盖设置打开、Hermes 模型/强度菜单、状态刷新和关闭：动作 07:20:12.626–07:20:52.144 UTC，观察 07:19:46.938–07:21:17.641 UTC，共 90.703 秒，新增控制台窗口事件 0，hookStopped=true。此前一次观察漏掉最后 2.49 秒，不作为完整覆盖证据；重新执行后的本轮报告为最终依据，不宣称未执行路径永远无窗口。
- [x] Windows 正常无调试参数运行；活动 Worker、ready 账号 scope、账号 owner、原生 Hermes/auth、观察器任务/launcher、UI/验收临时任务均为 0。Mac 设置已关闭，活动 Worker/账号桥进程为 0；本轮 Mac 未打开调试通道，Windows 使用原生 UI Automation，未开 CDP。未清空历史 Worker、账号或不相关配置。
- [x] 实现已阶段提交 `d342fc2`；本轮验收记录单独提交，保留用户原有文档/素材改动，不推送。严格规格 11/11；Hermes 10.1–10.4 完成，活动 change 为 32/34。历史 3.1/3.3 的 Claude 官方账号/额度跳过与 Kimi 验证边界不变，不归档整个 change。
- 私有证据均在 Git 忽略的 `.test-data/windows-remote/desktop-audit/`：`hermes-renewal-full-tests-v2.json`、`hermes-renewal-typecheck.log`、`hermes-renewal-preview-build-v2.log`、`hermes-renewal-mac-parser-actual.json`、`hermes-renewal-mac-formal-equivalence.json`、`hermes-renewal-mac-ui.json`、`hermes-renewal-mac-preflight.json`、`hermes-renewal-windows-parser-native-preview-20261011.json`、`hermes-windows-final-delivery-20261011.json`、`hermes-renewal-windows-final-install-20261011.json`、`hermes-final-complete-ui-actions-20261011.json`、`hermes-final-complete-ui-v5-20261011.json`、`hermes-windows-final-normal-startup-20261011.json`、`hermes-windows-final-cleanup-20261011.json`。账号秘密不写入报告或 Git。

## 2026-10-11：v0.7.7 发布前最终验收

- [x] 版本清单与中英文固定 npm 安装示例统一为 `0.7.7`；个人 Windows 详细复用手册保存在 `/doc/local/`，`.gitignore` 验证生效，Git 索引和公共包均不含个人手册、连接配置或运行日志。
- [x] 发布 CI 定位新版 Windows 伪控制台 HWND 归属差异，修复实际 conhost 身份解析。保留全部父进程、创建身份、系统映像和 Job 范围退出门禁，没有跳过失败用例。
- [x] 最终源码 `pnpm typecheck`、`pnpm test`、`pnpm build:preview`、`pnpm spec:check` 通过（命令均使用 `--config.verifyDepsBeforeRun=false`）。完整回归 1847 passed / 8 skipped，严格规格 11/11；Mac 跳过的平台专属用例由 Windows 单独执行。
- [x] [Windows CI 38123998760](https://github.com/SuperWheel/cliworker-now/actions/runs/38123998760) 在系统 build 26100 全流程通过：107 passed / 1 skipped，含真实 Host Job 与 ConPTY 停止/自然退出、后代清理和无关进程保留；官方 Codex 0.160.0、Pi 1.0.4、OMP 16.4.4 安装入口/帮助与原生元数据 smoke 通过，零模型调用。
- [x] 实际 Windows 22631 / Electron 44 / Harness SDK 双生命周期合成用例通过，TTY、Unicode/元字符 argv、输入输出、自然退出码7、分离子进程和 conhost 清理均核验。181034ms 交互式观察无额外可见控制台。仅精确分类宿主固定的 ConPTY 提示，未知告警与普通 Job fallback 仍失败。
- [x] 两平台无活动任务后正常退出 Harness，正式构建/原生安装并正常重启；实际界面均确认 v0.7.7、1 个组件运行。Windows 最终安装的 339 个 lib 文件逐项匹配，全部测试、观察器、账号范围与临时任务清理，无调试启动。
- [x] 最终公共包 344 文件，逐项匹配发布暂存，npm dry-run 通过；SHA-256：`fef207b47caab4f853fd2b1c8a04584dce0f99848281728647d4a48591d86559`。Client 可执行文本与前次两平台 UI 验收一致，preview 差异仅构建路径注释/源映射；新增 owner helper 与本次真实验收快照完全相同。
- 以上安装/进程检查不代表所有第三方账号、额度和真实模型生成全部通过。本轮没有新增账号登录、续期或模型调用，既有 Claude/Kimi 等真实账号/额度边界继续保留；活动 OpenSpec 不以发布为由归档。

## 2026-10-11：市场收录申请同步 v0.7.7

- [x] 现场确认原收录 PR [#6795](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6795) 仍为 OPEN、未合并；原提交的 PR check 和 Submission gate 曾通过。因此直接更新原分支，保留申请与审核历史。
- [x] 更新 `data/plugins/SuperWheel__cliworker-now.yml`：预构建包从固定 v0.6.5 链接改为 v0.7.7；中英文简介同步 macOS / Windows。更新提交 `ac1a1145573a3592f3b965a781a60f7dac34aa4e` 仅修改该文件的 3 行；PR 对上游仍仅新增自己的一个条目。标题和说明同步为当前版本，没有手改生成的 README 或其他插件。
- [x] 只读核验 GitHub/npm 公开 v0.7.7 安装包：字节一致，SHA-256 均为 `fef207b47caab4f853fd2b1c8a04584dce0f99848281728647d4a48591d86559`；校验文件、npm integrity、仓库关联、manifest、Cordis patch、编译入口及 344 文件清单通过。npm 映射由目录自动采集，不添加无效的 `npm` 字段。
- [x] 在当前精选列表的独立副本运行 `validateEntries`（4490 条）、`node scripts/generate-readme.mjs`、`git diff --check` 和 `SKIP_PUBLISH_CHECKS=1 node scripts/build-site.mjs`，中英文生成及官网本地构建通过；构建使用 CommandLineTools Git。未部署精选列表官网。
- [ ] 当前新提交的自动检查及维护者审核/合并：本次快照为 PR check IN_PROGRESS，仍未正式收录；原提交的绿灯不作为新提交已通过的证据。
- 本轮为目录元数据及发布记录更新，没有改动插件运行时、重新打包/安装插件或调用模型。公开发布报告中的回归及两平台验收未重跑。可复核证据保存于忽略目录 `.test-data/market-submission-6795/v0.7.7/`；源插件仓库只记录本地提交，不推送。

## 2026-10-12：v0.7.8 开发调整，Claude Code 与 CC Switch

- [x] 修复 Claude 自身路由被继承环境误判、Fable 原生字段被拒绝、`[1m]` 模型筛选及官方登录入口被路由前置检查阻塞的问题。状态与任务使用同一私有来源快照，mapping/top-level model 纳入账号绑定；managed 来源与目录重定向继续拒绝。用户 Claude/CC Switch settings、原生账号和历史不被插件改写。
- [x] 自定义网关未实现 `/models`（404/405）时，仅开放该路由明确配置模型，费用未知且说明远端可用性未核验；401/403、网络/无效响应、取消不回退。官方 API 与其他 CLI 不开放此配置例外。
- [x] 用户指定当前开发版本为 v0.7.8；已同步 package.json、AGENTS.md、OpenSpec 配置和中英文说明。只有用户批准后才增加后续版本号或上传 GitHub；日常仅关联最小验收，全量验收用于获准的版本发布。公开安装示例保留已发布 v0.7.7。
- [x] Mac 最小回归：`pnpm --config.verifyDepsBeforeRun=false exec vitest run tests/claude-own-route.test.ts` 为 39 passed；六文件 `accounts.test.ts / cli-account-binding.test.ts / first-party-models.test.ts / claude-native-oauth.test.ts / runtime-account-isolation.test.ts / account-models.test.ts` 使用 `-t 'Claude|claude|declared models|custom model declaration|failed 200|metadata requests'` 为 91 passed、187 项被标题过滤排除。共 130 个相关用例；没有跑全量测试。
- [x] Host/Client `typecheck`、隔离 `build:preview`、严格 `spec:check`（归档前 12/12）、`git diff --check` 通过。格式检查不作为真实模型验收。
- [x] Mac 原生只读检查：官方状态正常返回未登录、`auth login --help` 支持 `--claudeai`；当前自身路由状态正常，模型目录 GET 200，13 个目录选项含 3 个配置模型。原 settings 哈希保持不变，私有临时文件清理确认。未启动登录、退出或模型生成。
- [x] Mac 确认无活动 Worker/账号桥进程，正常退出 Harness 后正式 build 更新原本链接；正常重启，实际插件页显示 v0.7.8、共 1 个组件且运行中。正式 Host 可执行文本与 preview 相同（排除构建路径 region 注释）；本地包 344 文件，不含私有数据。
- [x] Windows 按原远程手册恢复连接：用户提供重启后 IPv4，新目标通过已固定旧公钥严格校验，仅增添同公钥的新地址别名及更新私有 config.host，原记录/其余字段保留，私有文件 0600。通用重连规则写入 `doc/windows-remote-testing.md`；机器地址和账户材料不入 Git。
- [x] Windows 原生 Claude 2.1.296 合成最小检查：自身 API settings 状态 exit 0，官方 overlay 状态 exit 1/未登录，官方登录帮助 exit 0 且支持 `--claudeai`；无实际账号读取、授权、模型调用，合成目录清理确认。
- [x] Windows 对应最小回归 39 + 91 = 130 passed、0 failed；187 项仅为标题过滤排除，选中用例无跳过。测试源码快照和两份原始 JSON 哈希核对，冻结依赖恢复后仅执行两组上述用例。本次合成账号、依赖、缓存及测试进程均清理确认。
- [x] Windows 安装前无活动 Worker/账号终端且 Harness 已退出；原生安装器 exit 0，本地 v0.7.8 的 339 个 lib 文件及 Host/包哈希与 Mac 构建完全一致。正常启动后 5 个 Harness 进程、调试参数 0；本次原生 Claude、账号授权、测试 run、UI 任务/观察器进程均为 0。不追加 UI 全量验收。
- 私有证据：`.test-data/claude-078/mac-minimal.json`、`mac-install.json`、`package.json`、`windows/native-probe-report.json`、`windows/minimal-report.json`、`windows/claude-own-route.json`、`windows/claude-related.json`、`windows/install-report.json`、`windows/delivery-summary.json`。本地开发包 `.test-data/claude-078/dsh-cliworker-now-0.7.8.tgz`，SHA-256 `0a6391816d4030435645b7531a5980f53619768422e3071928c2674cd497f953`。不提交凭据、私人远程配置、运行报告或用户既有素材改动；未推送、未发布 GitHub/npm。
- [x] 本次 OpenSpec 8/8 任务按最小证据核对完成，同步三项主规格后归档至 `openspec/changes/archive/2026-10-12-fix-claude-cc-switch-routing/`；归档后严格校验 11/11，原 Windows/MiMo 活动变更仍保留 34/36 的真实账号验收边界。实现本地提交 `45f95c1`，无远程推送。


## 2026-10-12：v0.7.8 Windows 桌面发现与本机 CLI 路径管理

- 复用 OpenSpec `discover-windows-desktop-clis`：Windows ZCode/OpenCode 读取默认位置、安装登记、已运行产品位置和有界快捷方式线索；DisplayIcon 是注册表元数据，桌面无图标仍可发现。自定义中文/空格/非系统盘路径核验实际 CLI 及配套文件；多安装拒绝猜选，GUI 不冒充 CLI。
- 全部 11 个 CLI 首次解析保存本机路径；手动指定优先于部署配置和自动记录。自动文件消失重新发现，手动错误保留并显示配置问题。Host Gateway 的路径、账号、模型和任务共用解析器，revision 防止迟到探测覆盖新选择；活动任务/账号终端时拒绝修改。
- 每个 CLI 页独立的同级“高级设置”默认折叠，展开后显示“CLI 路径管理”、预填/输入、刷新、恢复自动识别；不置于“项目默认设置”内部。应用后清除旧账号/模型显示并刷新，路径按机器及平台保存、跨项目共用。
- 关联自动检查：Windows 发现 helper 94 项、resolver 24 项通过；路径 store 45 项、resolver/Host API 30 项通过（最终三文件合跑 99/99）；settings-dialog 150/150 通过。账号状态专项 `-t 'missing manual path|Windows desktop discovery'` 为 3 通过、76 标题过滤。仅使用相关测试，未运行全量套件。
- 第一阶段 Windows 原生发现 16/16：真实安装查询、ZCode/OpenCode 实际文件核验、无 shortcut 的 registry/default 独立来源、中文空格合成自定义目录/真实 .lnk、歧义、GUI 拒绝、取消及所属进程退出；fixture 与 shortcut 已清理。运行中进程位置只做了合成解析覆盖（实机两款桌面均未运行，未主动启动）。私有证据 `.test-data/desktop-cli-078/native-report.json`、`run-707518dc-281d-4aee-b8fa-6f7791d332d1/`。
- 第一阶段 v0.7.8 本地包已在 Mac/Windows 核对安装；后续路径管理新增功能的最终包与界面验收记录另列如下，避免把前一阶段包误作最终交付。
- 边界：安装发现、文件可读、模拟状态和设置界面通过不等于真实账号授权或模型生成；此次未调用模型、未登录/退出真实账号。无 metadata、PATH、已知目录和运行中产品线索的任意便携目录仍需手动输入。未升版本、未推送 GitHub、未发布 npm；保留其他活动变更的真实账号/模型未验收事项。
- 第二阶段 Windows 原生 Node/文件系统路径管理 14/14：真实 store/resolver/Host API，禁止 spawn 的模拟 backend；覆盖自动保存重载、失效重找、中文空格手动路径、无效手动保留、reset/revision/迟到拒绝、API 忙碌门禁和清理阻塞。报告 `.test-data/desktop-cli-078/path-management-native-report.json`；远程 fixture 已清理。
- 最终 Host/Client 类型检查与 `build:preview` 通过，新增 Gateway 契约由原生生成器生成。Mac 更新前 22 条历史 worker、0 活动/排队任务、0 账号桥进程；正常退出后 `pnpm build` 更新现有链接并正常重启。实际 UI 已核对同级独立高级标题、默认折叠、Antigravity 与 ZCode 展开自动预填、Antigravity 路径刷新成功、切换 CLI 恢复折叠，以及右栏滚动后输入/按钮完整可用；未修改项目模型/强度。
- 最终本地包 `path-management-078-final.tgz` 为 v0.7.8，SHA-256 `29bcc4ce7eb8ac6780d59260c787a700d409132f2228bc82e2e32455ab278739`；Host `6687fe257d20fb6afe1dac9811541598bb711bf02fede56ea0551d762121991c`。Windows 原生安装 348/348 库文件哈希一致；Mac Host 相同，346/348 字节一致，两个 Client 差异经规范化核实仅为依赖路径注释及 source-map 路径。证据 `path-package.json`、`path-mac-install.json` 及 Windows `path-*` 私有报告。
- Windows 最终实际 UI：ZCode 高级设置初始 Collapsed，路径输入与管理标题未挂载；展开自动预填实际 managed CLI 文件、来源自动识别，刷新一次返回“CLI 路径已刷新”，路径保持，随后关闭设置。证据 `path-windows-ui-zcode-collapsed.json`、`path-windows-ui-zcode-expanded.json` 及本轮刷新/清理报告；未进行真实登录或模型任务。
- 已核对 11/11 任务、同步 7 项新增需求并归档 OpenSpec 为 `2026-10-12-discover-windows-desktop-clis`；归档前后严格校验均 12/12 通过，差异检查通过。其他活动变更保留 34/36 的原有未验收边界。


## 2026-10-12：v0.7.8 设置自动保存及截图细化

- `polish-cli-settings-autosave`：删除保存默认值按钮，模型/强度的用户选择自动保存；初始化/刷新不写偏好，连续选择串行保存最新组合，失败可重选重试，关闭/切 CLI/账号变化取消旧请求。
- 高级设置为独立静态 h3 + 右侧箭头按钮，默认折叠并保留 grid/opacity 过渡和 reduced-motion。路径管理改普通标签，与模型/强度一致；删除重复可见 CLI 路径与来源文字，保留输入可访问名称、说明和操作。
- 继续按截图去掉思考强度末行底边，避免与高级分区线重复；模型和强度菜单移除固定 300px，使用按钮实际宽度，保持原生 Menu portal/start 定位，ResizeObserver 随关闭/卸载清理。
- 最小自动检查：最终 `vitest run tests/settings-dialog.test.tsx` 158/158 通过；Client 类型检查、Host/Client typecheck 及最终 `build:preview` 通过；仅 NativeChoice 变更后重跑相关 UI 文件，不重跑 Host 原生发现或全量套件。最终报告 `.test-data/settings-polish-078/settings-final-tests.json`、`preview-final.log`。
- 最终本地包 `settings-polish-078-layout-final.tgz`，v0.7.8，SHA-256 `735d45ba8373262f83513475138d69abc64f201c37fb9f7d4aeeb04f43c21994`；Host 未改，SHA `6687fe257d20fb6afe1dac9811541598bb711bf02fede56ea0551d762121991c`。Mac 更新前 22 历史 worker、0 活动、0 账号桥，正常退出/构建/重启。346/348 库文件与 preview 字节一致，两个 Client 差异仅为依赖路径注释/source-map 路径，规范化对比通过。
- 自动保存 Windows 实机中间包证据：原模型及 Low 原强度分别重选，均显示默认设置已保存；偏好内容哈希保持不变，mtime 分别前进，确认写入。未调用模型、未变更账号。最终样式包的实际检查另记如下。
- Mac 最终实机：模型与强度菜单均目测与各自选择框左右对齐；只剩一条高级分区线。原 GLM-5.3-Flash/Low 分别重选，均出现“默认设置已保存”；8 份偏好内容哈希全部保持，仅对应偏好 mtime 两次依次前进。高级设置初始折叠，点击静态标题不切换，右箭头展开/折叠正常；普通路径标签、说明、输入及两按钮可见，无重复标签/来源。已关闭设置。证据 `.test-data/settings-polish-078/mac-layout-ui-report.json`；未额外检查窗口缩放。
- 用户继续要求统一排版，前述 layout 包及其 UI 证据改记本阶段中间结果；最终交付另以统一参数包为准。新增 `doc/settings-ui-design.md`，将字号/行高/字重、16px 行留白、8px 标题后距、4px 文字组间距、单条边界及反馈规则固定成共同规范，并接入 AGENTS/README。
- 统一排版最终纯 CSS：`build:preview` 与正式 `build` 均通过（含必要编译），不重复运行已通过的 158 项交互回归。最终包 `settings-polish-078-uniform-final.tgz`，v0.7.8，SHA-256 `fe5226b5c8632335e3a8f666b36dd7daa27013061cd24bcc4beed319bde905f8`；Host 不变，348 个 lib 文件，Mac 346 个字节一致、两个 Client 仅构建路径差异。
- Mac 统一排版实机已核对：项目/高级标题到首个文字组的距离一致、标题和标签层级一致、模型/强度及分区均单条分隔线、路径输入和按钮滚动后完整可见、折叠后内容留白一并收起，强度菜单仍与选择框等宽。设置已关闭；8 份偏好文件哈希及 mtime 与前一次自动保存检查后完全一致。证据 `mac-uniform-idle.json`、`mac-uniform-install.json`、`mac-uniform-ui-report.json`。
- Windows 统一排版包原生安装 348/348 文件哈希匹配，正常启动。UIA 测得项目标题与模型标签顶部差 109 屏幕像素，高级标题与路径标签顶部差也为 109；两处标题高度均 44、普通标签高度均 37，初始折叠。证据 `uniform-windows-ui-layout-final.json`；数值为当前缩放后的屏幕物理像素，并非 CSS 参数。
- Windows 统一排版最终 UI：完整路径输入/恢复/刷新可见可操作，高级区展开前与收起后高度均 121 屏幕像素，无额外折叠留白；模型及强度菜单均 480px，与选择框一致。设置已关闭，无新增偏好写入或模型/登录调用。证据 `uniform-windows-ui-layout-final.json`、`uniform-windows-ui-states.json`、`uniform-windows-ui-menus-final.json`。远程通道继续用于用户随后反馈的 OpenCode 识别问题，相关诊断和最终清理单独记录。
- 设置页 OpenSpec 4/4 完成；已同步两项主规格，再归档到 `2026-10-12-polish-cli-settings-autosave`。严格校验归档前 13/13、归档后 12/12。原 Windows/MiMo 活动变更继续保留 34/36 未验收边界；未增版本、未上传 GitHub，未跑全量验收。

## 2026-10-12：v0.7.8 Windows OpenCode 识别回归修复

- 用户补充 v0.7.7 能正常识别；Git 对比确认 `021441b`（0.7.7）无桌面归档 helper，`1b12366`（0.7.8）首次新增。不是用户安装丢失：Windows 普通 Node 已核实 npm 原生 CLI 为 PE subsystem 3，桌面另有可用独立 CLI，无手动/部署覆盖或 `.local/bin` 抢占。
- 真实 Electron 44.0.0 / Node 24.18.1 Host 一次可逆诊断：实际选中 npm `opencode.exe`、explicit=false，却因其旁侧不存在 `resources/app.asar` 抛无 code 的 `Invalid package`。恢复原 bundle 后 SHA-256 与 `6687fe257d20fb6afe1dac9811541598bb711bf02fede56ea0551d762121991c` 一致；没有修改账号/配置。私有证据 `.test-data/opencode-diagnosis-078/actual-host-error.json`、`host-diagnostic-restored.json`；原始路径不入 Git。
- Windows 安装 helper 改为局部懒加载物理 FS：Electron 内置 `original-fs`，普通 Node `node:fs`。不修改全局 noAsar、不吞异常字符串；继续拒绝损坏 PE、目录假文件、权限错误和显式 GUI。
- 最小自动验收：`pnpm test tests/windows-desktop-cli-installation.test.ts tests/windows-cli-resolution.test.ts tests/native-launch.test.ts tests/windows-desktop-cli-electron-fs.test.ts` 144/144 通过，新增 Electron synthetic 专项 11/11（执行时修复已落盘，未声称单测 red；真实 red 来自上述 Host 证据）。`pnpm typecheck`、`pnpm build:preview` 通过；最终 bundle 保留局部 runtime `createRequire(import.meta.url)("original-fs")`。日志在该私有目录 `regression.json`、`typecheck.log`、`preview.log`。
- 修复包 `opencode-electron-078-final.tgz`，v0.7.8；SHA-256 `82134a8f7f870208a8bf90b1a40c92a943f8fa2e8d7a65b9fbe9807d79f77613`，Host `d893e4e321217c2d9a38c51af075fb91698e7a7b7af34508d232472983bf103a`。没有全量验收、登录或模型生成，未升号、未推送。
- Mac 更新前确认 22 条历史 worker、0 活动、0 账号桥，正常退出后 `pnpm build` 通过并重启。Desktop 链接仍指向本项目、Host hash 与 preview 相同，346/348 库文件字节一致，差异仅限此前已有的两个 Client 构建路径文件。正常重启后 CUA 确认 CLI Worker 面板、三个历史子 Agent 正常显示；本次未打开账号/改偏好或生成，证据 `mac-install.json`、`mac-loaded.json`。
- Windows 正式安装 348/348 库文件 hash 匹配，实际账号区显示 Z.AI API 登录，入口错误消失，原生目录列出 5 个模型（仅展开未选择）。高级设置自动预填原 npm CLI，store 从 revision 2 无 entry 变为 revision 3 / mode:auto；关闭重开后路径、revision、文件 hash/mtime 均不变。两个模型偏好 hash/mtime 全部未改，无登录/模型生成。证据 `windows-delivery-summary.json`、`fix-store-first.json`、`fix-store-reopened.json` 及 settings 私有目录的 `opencode-fix-ui-*`。
- 本轮诊断清单 99 文件及额外运输脚本、25 个 UI 任务已清理；正常 Desktop 进程 5、debug 0、活动任务 0。当前安装依赖引用的新 tgz 保留；更新过程发现 pnpm 会重读旧本地 tgz，已从同 hash 副本恢复旧源后成功更新，清理不再删除当前依赖引用的包。Mac 失败的独立探针未产生 fs 结果，不作为验收证据，生成 app/链接已清理。用户随后反馈设置操作弹终端窗口，另立后续调查，不将入口识别通过描述为窗口行为已验收。
- OpenSpec 6/6 完成，已归档为 `2026-10-13-fix-electron-windows-opencode-detection` 并同步物理安装识别主规格；严格校验归档前 13/13、归档后 12/12。既有 Windows/MiMo 变更保留 34/36 未验证边界。

## 2026-10-13：v0.7.8 Windows 设置后台终端弹窗修复

- 调用链核对：首次设置并发查询全部启用 CLI 账号；模型／强度自动保存重新读取账号绑定和原生目录。后台路径均使用 nativeProcessBackend，SDK PATH 查询本身不创建进程。自有 native/PowerShell/Python/Bun 启动均已有隐藏边界；Pi/Hermes 的第三方内部派生不以静态审查当作已实测。
- 实机旧包：冷首开捕获 Codex 和 AGY 关联标题的 CASCADIA 窗口；第二次可逆 Host 安全日志完整观察 120.9 秒，仅复现 Codex。Codex npm 0.162.1 脚本内部继承句柄派生 exe、没有 windowsHide；实际父链为 Host→SDK Electron→脚本 Electron→平台包 codex.exe→conhost，并与 Windows Terminal 窗口对齐。Antigravity 原生 `models` 与账号 PowerShell 均 relay=true，后续完整观察未复现其窗口；首次 AGY 标题事件无法唯一归因，仍保留线索，未编造根因。证据 `.test-data/settings-console-078/{cold-observer,effort-observer,spawn-diag-observer,spawn-log-final,codex-live-process,agy-live-process}.json`。
- 可逆诊断只保存固定操作分类、时间和程序路径，不记录完整 argv、环境或凭据。已恢复旧正式 Host SHA-256 `d893e4e321217c2d9a38c51af075fb91698e7a7b7af34508d232472983bf103a`，正常退出／重启，无调试参数；观察工具使用 GUI launcher，与产品进程分开归属。旧用户 Codex Desktop 进程未被误作插件子进程或清理对象。
- 修复范围：已核验 Codex wrapper 指纹后台转同安装原生 exe，保留原 argv、包管理器环境与 SDK Job／退出回执，未知脚本保持既有行为；不修改已记忆路径、账号终端或 macOS 分支。失败继续短错误，不静默换安装。
- 最小自动验收：模块 29/29、后台集成 10/10、`tests/native-launch.test.ts tests/windows-hidden-process.test.ts tests/native-spawn.test.ts tests/launcher-console.test.ts` 42/42，共 81 项通过。模块首跑失败为 synthetic 测试删目录未加 recursive，修正夹具后通过，未声称生产修复的 red 单测。`pnpm typecheck`、最终 `pnpm build:preview` 通过，最终 preview 源码 hash 与当前模块一致；没有全量测试或真实生成。
- 隔离包 `settings-console-078-final.tgz` SHA-256 `ebfd9164c8e5e3c55bf09f94a22b62059a6b664616569d40aa25bc18ceff6d54`，Host `3edb7e766078aed65d22f603889963af8108cbd64375ff71eaf4a16196b5140d`，351 个 lib 文件，版本 0.7.8。Mac 只读确认 22 历史 worker、0 活动、0 账号桥；随后 CUA 报 Mac 锁屏，未更新当前 Mac Desktop 链接的正式 lib、未声称本轮 Mac UI 验收，保留先前已安装的 OpenCode 修复包；本次 Windows 专用变更通过 Mac 类型检查、构建和非 Windows 分支回归。
- Codex 修复包安装后 351/351 文件哈希一致；301.384 秒冷开与设置观察中 Codex 不再弹窗，但在 16:29 UTC 冷首次设置后仍捕获 AGY 标题的可见 CASCADIA 窗口。该结果为部分通过，不能把前次 15 分钟内的热读无窗口记成全部修复。冷 AGY 3036→28472→31232 自派生，热查询没有同名后代；证据 `.test-data/settings-console-078/final-observer.json` 与 `final-codex-live-process.json`。
- 针对 AGY 继续核查：官方更新器使用 15 分钟 TTL，禁用值须为 `true`；增加 Windows 后台模型／任务的子进程环境开关，保留显式账号终端。后续验收须确认 updater 日志／冷观察，且不修改用户 updater 时间标记以掩盖问题。
- AGY 根因实证：原生日志 `cli-20261013_002930.log` 第 68 行 `auto_updater.go:334` 在 00:29:32.068622（UTC+8）记录启动后台更新进程 PID 28472，与本轮窗口链一致；00:06 另有同类派生，00:09/15/20/30/31/32 则记录 TTL skip。二进制含官方禁更新变量及 Windows updater 字符串。仅保存固定类别／PID 的脱敏投影 `.test-data/settings-console-078/agy-updater-log-projection.json`，不保存完整用户日志到 Git。
- AGY 最小补充回归：`tests/agy-background-environment.test.ts tests/authorized-catalog-windows-agy.test.ts tests/runtime-account-isolation.test.ts tests/accounts.test.ts -t "AGY background"`，9/9 通过，117 项按名称过滤未执行。覆盖当前／旧目录、任务启动、Windows exact true、macOS/Linux 不注入、MiMo 环境与父环境、显式账号终端和清理；加上先前 81 项，本次累计 90 项定向通过。Host tsc 及最终 `build:preview`（含 Host／Client 类型构建）通过，无全量测试和真实生成。证据 `agy-background-tests.json`、`preview-agy.log`。
- AGY 最终隔离包 `settings-console-078-agy-final.tgz` SHA-256 `15b5ec33741185103a63ed8d3a82c41cbc982742b397ed17747a6f5a3071e651`，Host `08e9b9abbb9eddf2ae9494f62caa4d6c0b19b6be16544446a3be8218eefda3d5`，354 lib 文件，版本仍 0.7.8。
- 最终 Windows 安装 354/354 lib 哈希匹配，正常冷启动后首开 AGY 模型／强度就绪；`00:48:05 auto_updater.go:247` 明确记录环境开关禁用自动更新。updater marker 始终为 `16:29:32.0686222Z`，冷首开已超过 15 分钟，排除 TTL 内热读造成的假阴性；未删除或改写 updater 文件。
- 最终实机窗口验收：`agy-final-observer.json` 覆盖 16:47:53.166–16:51:54.552 UTC（241386 ms），全部新增 Console／CASCADIA／WindowsTerminal 窗口事件为 0，未按父链过滤遗漏系统激活的终端。四次 AGY 查询均无同名自派生，四份日志均明确 updater disabled。AGY 首读就绪，原模型与 Low 同值重选真实触发自动保存并成功（无错误）；刷新在 7 秒快照时仍等待，随后模型菜单可用并完成保存，不把中间快照当作完成。Codex 页面／刷新正常，未创建新的 Codex 偏好；原 AGY／MiMo 偏好内容哈希保持一致。未发起模型生成或登录。
- 其他入口核对：任务初次／恢复／续聊共用普通 launch；账号状态、目录、安装发现和自有 Node/Bun/Python/PowerShell 引导器已有后台隐藏设置。AGY Windows 账号身份只读固定 PowerShell，不启动 AGY；用户显式账号终端保持交互。先前同包 Codex 修复观察覆盖 11 个 CLI 页，未捕获第三种后台窗口；部分 CLI 的认证／目录未就绪仅记录原状态，不宣称所有账号与模型端到端通过。未知 Codex wrapper 版本及第三方任意内部派生未获得普遍窗口保证。
- 收尾核对：Windows 仍为正常 Desktop 启动，正式 Host 哈希匹配最终包、无诊断参数；0 活动 worker、0 账号 owner、0 查询 helper、0 observer task／launcher。只清理本轮登记的临时脚本／诊断任务，保留当前依赖引用的安装包、用户终端及历史数据。完整私有汇总 `.test-data/settings-console-078/windows-delivery-summary.json`；本次增量规格同步、严格校验及归档，本地阶段提交，无 GitHub 推送或版本增加。旧登录／MiMo change 的 34/36 与真实模型缺口保持可见。

## 2026-10-13：v0.7.8 获准发布验收与模型目录修复

- 用户授权调用 GPT-6.1 Sol 执行全量验收及 GitHub、npm、dshmarket 提交。本次保持 v0.7.8；三个 Sol 验收分工分别核对 Mac、Windows 及安装/模型来源，不以子 Agent 自述替代日志和实机结果。
- 隔离 HOME/DSH_HOME 与临时 profile 的真实安装验证：首次无版本名得到当时 latest 0.7.7，但已装 `^0.7.6` 或固定 `0.7.6` 后使用无版本名均保持旧版；`@latest` 能升级并重复执行。双语 README 因此统一使用 `dsh plugin --profile desktop add dsh-cliworker-now@latest`，明确命令触发升级、宿主启动不自动升级。原始输出与版本/lock/config 核对保留于 `.test-data/release-078-sol61/install-command/`。
- Windows Claude：经用户明确授权向当前本机 CC Switch 执行一次只读模型 GET，确认 HTTP 200 且原始数组为空。修复保留原生配置角色模型，标签与执行 ID 分离；只适用于自身 loopback 原始空目录，filtered-empty、远端空目录、401/403/网络失败均有拒绝回归。未执行模型生成、登录或账号切换。
- Codex：确认旧固定目录查询版本漏掉 GPT-6 模型，改从 app-server 握手获取当前 CLI 版本，再按自身账号返回的 ID 和思考强度补充原生陈旧缓存。正式界面检查又发现新加入的 NUX 过滤误删 GPT-6.1-Sol；官方只读元数据显示它可见、支持 API、最低版本满足，NUX 是推荐提示。删除错误过滤并保留明确 deny/hide 规则，重新冻结与全量验收，没有将中间通过结果当作最终结果。
- 新设置缓存覆盖首次识别、重复打开、重启同内容不写、内容变化更新、项目隔离、手动刷新、账号/路径变化、取消及并发、错误不回退、恶意文件/目录链接和有效默认值保留。设置页手动刷新改为独立 Gateway 方法，旧测试夹具同步，229 项关联测试通过。
- 首次 Windows 全量实际出现 132 项失败，已保留失败报告并逐项分解。修复控制管道自然退出、OMP SQLite/请求目录超长路径、Hermes/OpenCode/Pi 文件链接与竞态检查；跨平台夹具使用原生路径与 Windows Python，POSIX mode/SIGTERM 专属断言按平台限定，未用整套跳过掩盖业务失败。7 文件针对性 Windows 复验 173 通过、2 POSIX 跳过。
- 中间 Mac 全量曾有 4 项设置刷新夹具失败和 3 个未处理模拟拒绝；修复后 `final-freeze-2` 为 2190 通过、8 跳过，但真实 UI 检查发现上述 NUX 缺陷，因此最终结论以后续 `final-freeze-3` 与 Windows 最终记录为准。所有中间失败证据保留，不覆盖。
- 最终同一运行时代码：Mac 完整 101 文件，2190 通过、8 平台跳过、0 失败；Windows 完整 101 文件，2179 通过、19 平台跳过、0 失败。最终 3 个跨平台夹具分别核验无 Appx 安装的只读查询、Grok 原生 GROK_AUTH_PATH 以及 Hermes 合成终端提供者；没有新增整套跳过。最终 JSON 位于 `.test-data/release-078-sol61/mac-final-after-platform-fixtures.json` 和 `windows/final-full-tests.json`。
- 隔离 preview、Host/Client 类型检查、Windows 新生成 Gateway 类型检查和 Host import 全通过。139 个源码文件与 preview 一致；最终构建 357 个 lib 文件，Client 仅构建位置 region 注释/映射与 preview 不同，可执行内容相同；源码与两份 account-models helper 的哈希一致。严格 OpenSpec 校验 13/13 通过。
- Mac 正式构建前确认 Harness 已退出、22 个历史 Worker 中活动数为 0、无账号/任务 bridge。真实 Desktop 看见 Codex 7 项含 GPT-6.1-Sol/GPT-6-Astra/GPT-6-Luna，原 GPT-5.6-Luna Low 保留；Claude 自身 API 路由显示 13 项及配置候选边界说明。重复打开与手动刷新同目录不改 inode/mtime，重启后 Antigravity 重识别同值不写，Codex 6→7 项变化更新；8 个偏好文件哈希不变，缓存文件均 0600。设置分隔线、标题、折叠路径区、菜单等宽已实际渲染核验。
- 待发布候选包共 362 个文件，公共清单 `private:false`、无生命周期脚本/开发依赖/私有资料/链接；开发清单仍 `private:true`。tgz SHA-256：`e2eebaebcb0e3cdcd503d070428de668add7288f7eaf8756cb43a8677f4a0f51`。Host：`31914eb59a1439b72e53e2416a8d266ae35516bcd08cf34d413a55b05da1f7aa`；Client：`bb57da4ca8df6416b5c65f08711f9ab9f330ece075932c6d098176b697ad6f5e`。此阶段完成自动检查和 Mac UI；Windows 最终包 UI、远端 CI 与公开分发回下载将在后续记录，不能提前视为完成。

## v0.7.8 发布收尾（2026-10-13）

- 用户已明确批准使用 GPT-6.1 Sol 全量验收，以及 GitHub、npm、dshmarket 提交更新；当前发布版本仍为 v0.7.8，没有增加后续版本号。
- 最终源码提交 `220cd8896be0340eb2b980e8866d034e82e9e424`。Mac 全量 101 个文件、2198 项断言中 2190 通过、8 个平台跳过、0 失败；Windows 2179 通过、19 个平台跳过、0 失败。类型检查、隔离构建及 Windows Host 加载通过。跳过项是平台权限、shebang、文件链接及 POSIX 信号语义等，不计入通过数。
- Mac 正式 Desktop 核验模型/强度菜单、统一样式、默认折叠高级设置、关闭重开、宿主重启及手动刷新：Codex 显示 7 个当前账号模型（含 GPT-6.1-Sol、GPT-6-Astra、GPT-6-Luna），Claude 显示 13 个自身路由候选。目录变化时更新，同内容刷新不重写；8 份项目偏好哈希保持不变，缓存权限为 0600。
- Windows 最终公开候选包经原生安装器安装，357 个 lib 文件逐一匹配，11 个 CLI 设置页中 9 个目录就绪，Kimi 凭据过期和 Grok 账号无法确认保持明确不可选原因。Codex 7 个模型及真实强度、Claude 4 个原生配置 ID、OpenCode/ZCode 路径管理均已实机读回。同宿主重复打开复用目录；首次重新识别期间保留加载状态。
- Windows 最终包全局窗口观察持续 602704 ms，补充保存反馈观察 90641 ms，两段均自然停止且可见终端事件 0。最终包重选原 Antigravity 模型验证自动保存反馈（此前基线对 MiMo 也作一次同值重选），没有选择其他模型或强度；两份偏好内容哈希保持不变，仅同值保存更新时间。关闭设置发生在观察结束后，不将关闭动作计作被窗口观察覆盖。
- 实际 Windows Electron 44 / 宿主 SDK 下的合成 ConPTY 停止和自然退出（退出码 7）均通过：真实 TTY、参数字面值、stdin 往返、原生 PID、后代退出和无关进程保留均核实；没有应急杀进程，1 条已知 SDK 提示、0 条意外提示。最终活动 Worker、ready 账号 scope、账号 owner、测试任务、观察器及所属辅助进程均为 0；保留现有持久账号目录、历史和正常 Desktop。
- GitHub CI [38333156799](https://github.com/SuperWheel/dsh-cliworker-now/actions/runs/38333156799) 对上述精确提交成功。公开 tgz 有 362 个普通文件，无符号链接、私有日志或生命周期脚本；root manifest 保持 private，公开 manifest 为可发布预构建包。SHA-256：`e2eebaebcb0e3cdcd503d070428de668add7288f7eaf8756cb43a8677f4a0f51`；Host `31914eb59a1439b72e53e2416a8d266ae35516bcd08cf34d413a55b05da1f7aa`，Client `bb57da4ca8df6416b5c65f08711f9ab9f330ece075932c6d098176b697ad6f5e`。
- GitHub v0.7.8 Release 已公开，三项资产经匿名回下载匹配。npm 发布命令成功退出并返回 PUT 202，但截至 2026-10-13 02:41:56 UTC，公开 0.7.8 元数据仍返回 404、latest 仍为 0.7.7；未重复发布、未撤包，公开传播待完成。
- 旧版独立安装已验证无版本安装不能保证升级、@latest 可以升级至当时公开的 0.7.7。由于 0.7.8 尚未公开，本版 npm 回下载与 0.7.7→0.7.8 升级没有执行，继续保留待办，不能声称通过。
- 市场沿用 [PR #6795](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6795)，最新提交 `68a970fcfaef364663a13f510e594373b291c3ac` 同步新仓库名、条目名与 v0.7.8 固定 tarball；已推送并读回远端，状态 OPEN，市场审核状态单独记录，不声称官网已经上架。
- 真实账号登录及模型生成均未执行。Claude 本机辅助目录的授权独立 GET 返回成功原始空数组；配置候选只表示用户路由配置，不能声称已通过生成。Kimi/Grok 账号受阻不计为目录就绪；平台层、合成验收与真实第三方生成严格分开。
- 本地私有证据保存在 `.test-data/release-078-sol61/`：`mac-final-after-platform-fixtures.json`、`mac-final-ui-verification.json`、`windows/final-delivery-summary.json`、`windows/final-platform-skips.json`、`github-ci.json`、`publish-assets/package-verification.json` 及公开安装下载报告。凭据、机器连接信息和原始运行记录未入 Git。
- Release 标题按用户新增要求改为 `dsh-cliworker-now v0.7.8`，正文沿用 v0.7.7 的 `## 版本`、简介、`### 更新`、`### 安装或更新`、`### 验证` 层级；通过 GitHub API 读回精确核对。规范和可复制 Markdown 模板保存至 `doc/release-template.md`，并加入 `AGENTS.md` 的交付约定，提交 `f24f5f3`。
- 主规格已按最终实现同步，严格校验通过；npm 公开下载/升级仍未完成，因此发布变更保持活动，不提前归档。

## 2026-10-13 外部分发改名与安装界面保留

- 用户要求仓库及外部插件名称统一为 `dsh-cliworker-now`，随后明确 DSH 中已安装插件的界面名称全部不改。最终只保留分发文档、打包元数据、GitHub/Release 和目录提交修改；准备中的全部运行时、界面及关联测试改动已逐字节恢复至本次改名前 HEAD，正式 Desktop 未被覆盖。
- GitHub 仓库已改为 `SuperWheel/dsh-cliworker-now`，repo ID 保持 `1407409202`、Stars 保持 4，本地 origin 已同步；5 个 Release 标题均为 `dsh-cliworker-now v<版本号>`。旧仓库 API 自动指向新名，旧新 v0.7.8 tgz 下载均为 HTTP 200、16395067 字节、同一 `e2eeba…f51` SHA-256。完整哈希见前述发布记录。
- npm 包原本已名为 `dsh-cliworker-now`。当前 package、未来公开包生成器的 repository/bugs/homepage 指向新仓库，开发 private 标志仍为 true；没有覆盖已冻结包、修改版本或改变账号/会话路径。Release 模板按新外部名称更新，安装界面原名要求写入 AGENTS.md。
- 市场沿用 PR #6795，新文件为 `data/plugins/SuperWheel__dsh-cliworker-now.yml`，只有一个本插件条目；条目/PR 名称、仓库与包链接均回读匹配。全目录 schema 4415 条、双语生成和站点构建通过，远端审核保持 OPEN，不声称已上架。
- dshfind 原条目安装探测停留 0.6.5；下载采集需站点维护权限。只读快照 npm 官方 462、npmmirror 25（2026-10-10 至 2026-10-13），按目录 npm 渠道为 487，GitHub 全部 Release 资产 29 单独记录；这些不是独立用户数，也没有写死进页面。
- 已提交 [dshfind PR #51](https://github.com/hikariming/dshfind/pull/51)，提交 `bd643d647c3f51ab86938bc3c983c1b9ee0f880f`，仅修改三文件：本插件旧新名映射、经核验的历史 npm 回链兼容和回归；44 项辅助函数测试通过。没有改变其他别名策略、全站下载门槛或工作流；没有 D1 写入/部署权限，因此主键迁移与公开页面刷新仍待维护方完成，保留未勾选任务。维护步骤见 `doc/dshfind-sync.md`。
- 名称预览曾执行 318 项关联检查及 typecheck，但用户澄清后对应实现已撤回，不将这些当作当前新增功能。最终运行时/测试零 diff，139 个源码文件与重新生成的隔离 preview 全部一致，冻结包哈希不变；浏览器复查恢复 CLI Worker NOW。此次外部分发修改未重复全量或真实模型调用。
- 私有证据：`.test-data/dshfind-078/` 中 repository-rename、redirect-verification、release-names-after、ui-preserved-final、dshfind-pr-receipt，以及市场 canonical-market-update-receipt；均未作为运行数据提交 Git。


## 2026-10-13 npm v0.7.8 公开后核验与链接延期

- 用户确认 npm v0.7.8 已成功公开并取消删除重传。03:00:53 UTC 匿名读取固定版本及 latest 均为 0.7.8；npm 记录的发布时间为 02:58:52.809 UTC。此前维护者状态为 validating，现已结束；未撤包、未重复发布，未改版本或冻结资产。
- npm 与 GitHub Release 公开 tgz 逐字节一致，SHA-256 为 `e2eebaebcb0e3cdcd503d070428de668add7288f7eaf8756cb43a8677f4a0f51`，npm integrity 匹配。隔离 profile 显式安装 npm 0.7.8、原生命令列包/导出配置通过，362 个安装文件全部与冻结包匹配。
- 新发现：开发 pnpm 11.25.0 与真实 Desktop 自带 pnpm 11.7.0，在独立 0.7.7 profile 中执行 `@latest` 均退出 0 但仍为 0.7.7，与 pnpm 11 默认 1440 分钟的新版本等待策略一致。当前 0.7.8 按 npm 时间约在 2026-10-14 10:58:53（北京时间）满足默认年龄条件，实际仍须届时查询核验；没有提前报告升级成功。固定版本安装由 pnpm 原生在测试 profile 写入仅针对该精确版本的年龄例外，之后再执行 latest 保持 0.7.8，不能以此代替无例外的默认升级验收。
- 两次独立 Host 加载夹具均检测到 Client 解析到开发仓库而非 registry 安装目录，主动拒绝该来源；未计为公开包 Host/Client 加载或自然退出通过。超时后仅向测试进程范围发送 SIGTERM，两个观测端口关闭，测试 Host 进程全部退出。没有修改用户 Desktop、账号或安装器策略，账号查询和模型生成均为 0。
- 用户明确选择保留 v0.7.8，Repository/Homepage 留待下一次批准发布时同步。源码及未来打包清单的 repository/bugs/homepage 已指向 `SuperWheel/dsh-cliworker-now`，但已发布 0.7.8 包保留冻结时的旧字段；GitHub 旧链接仍重定向。此要求写入 `doc/release-template.md`，不擅自升号。
- 双语安装说明、Release 和分发规格已补充安装器等待规则及实际版本核对，不改变主安装行。v0.7.8 Release 已通过 API 精确回读；三个原资产保留。规格严格校验 14/14，通过 diff 检查；运行时代码和版本无改动，未重复全量测试。发布变更为 11/12，4.2 默认 latest 升级保留待办，不归档；npm Host 来源检查失败也保留在本记录中。
- 市场 PR #6795 的两项检查均成功但仍 OPEN；dshfind PR #51 仍 OPEN、无检查结果，页面迁移继续待维护方处理。私有证据：`.test-data/release-078-sol61/install-078/final-acceptance-receipt.json`、`desktop-install-078/carrier-installed.json`、`release-after-npm-public.json`。


## 2026-10-13 npm 安装夹具来源纠正

- 前述两次 Host 验收失败的原因是独立夹具缺少自己的 package.json，SDK 的最近包查找向上归属到开发仓库，从而注册了仓库 Client；不是 npm 包缺少 Client。新增只有唯一 name/private/type 的夹具清单后复验通过，保留原失败记录。
- 原生 Desktop 独立安装的 npm 0.7.8，362 个文件匹配；Host/Client 均解析到安装目录，appReady 后 appExit(0) 自然退出，未发送终止信号，端口关闭且 PID 消失，清理回执通过。账号/CLI/模型调用为 0。证据 `.test-data/release-078-sol61/desktop-install-078/verified-host/` 三份 host-graph、host-lifecycle、host-cleanup 回执。此结果不替代仍待验证的默认 @latest 年龄等待后升级。


## 2026-10-13 GitHub 源码安装最小验收

- 版本保持 0.7.8。新增开发清单 `prepack: node scripts/build.mjs`，用户明确批准后将源码入口提交 `0c68753a70098c3bed4ca36f1c2bc5350510fa56` 推送 main；本次后续说明只修改文档与规格，不改变该提交已验收的构建或运行代码。
- `pnpm_config_verify_deps_before_run=never pnpm build:preview` 通过。开发清单没有 prepare；冻结 npm/tgz 清单仍无 scripts，SHA-256 保持 `e2eebaebcb0e3cdcd503d070428de668add7288f7eaf8756cb43a8677f4a0f51`。没有正式重建用户 Desktop，也没有重发 npm 或替换 Release 资产。
- macOS 使用 Desktop 内置 dsh 和独立命名 profile，实际执行不带 `#` 的 GitHub 简写，解析到上述提交；首次被 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 拒绝，仅按当次确切来源键追加独立 profile 的 allowBuilds 后重试退出 0。prepack 生成 357 个 lib 文件，原生 bundle 登记正确；Host/Client 均从安装目录加载，appReady 后自然 appExit(0)，端口关闭、PID 消失，未发送终止信号。证据 `.test-data/github-source-078/mac/final-receipt.json`。
- Windows 使用 Desktop 内置 dsh 和独立命名 profile，实际执行固定同一完整 SHA 的 GitHub 简写。外层安装器 pnpm 11.7.0；源码构建要求 PATH 可调用固定 pnpm 11.25.0。首次构建拒绝、缺少 pnpm 命令及后续 `readStream must be readable` 均保留失败回执，不能将这些尝试计为安装通过。
- Windows 合成对照中，相同环境和 cmd，100 字符 cwd 可正常启动，实际存在的 299 字符 cwd 则 spawn ENOENT 且管道不可读；该目录明确为模拟，不是已被安装器删除的原失败现场。仅将本轮隔离根及缓存移至较短路径、保持依赖/构建脚本和包管理器版本不变后，原生命令退出 0，prepack 完成，357 个 lib 文件及 Host/Client/协议/辅助资产齐备，bundle 原生登记成功。长路径是结合对照与复验支持的原因判断，不把合成探针写成原现场直接证据。成功与失败记录位于 `.test-data/github-source-078/windows/`。安装后的真实 Desktop profile 三项配置哈希保持不变，顶层安装器 close/exit 0 已确认；最后 SSH 超时导致额外 exports 导入探针未上传、未执行，最终全进程退出观测未完成，不能声明 Windows 完整加载或全部后代清理通过。远端隔离安装及缓存保留。
- 双语 README 和发布模板补齐 Desktop/Web 命令、Node/pnpm 前置条件、精确构建授权、固定 commit、旧 v0.7.8 Tag 限制及 Windows 路径注意事项。主规格同步 GitHub 源码安装需求；`pnpm spec:check` 严格校验通过，相关差异检查通过。
- 本次仅最小构建/安装验收，真实账号查询、登录和模型调用为 0。未运行全量回归、Web profile 独立实装、全部 CLI 生成或 Windows 完整 Host/UI 生命周期；用户实际 Desktop profile 与全局构建保护未修改。默认 npm @latest 年龄等待后的升级仍保持原待办。

## 2026-10-15：v0.7.9 GitHub #1/#2 AGY 修复（最小验收）

- 用户本轮明确定位开发版本 v0.7.9，正式提交 GitHub 前不额外升号；bug 修复只做最小验收，全量验收留在获准正式提交 GitHub 之前。包清单、AGENTS、OpenSpec 配置/流程和双语 README 已同步；已发布 v0.7.8 下载地址保持有效版本。
- [Issue #1](https://github.com/SuperWheel/dsh-cliworker-now/issues/1)：保存本轮实际回复与独立汇总错误；AGY 续聊仅在退出、会话身份、完整 DONE 步骤、非空 DONE 回复和无本轮错误/清理异常等证据同时满足时显示 uncertain（结果待核实），不宣称成功或已证明旧 EOF。宿主 job 外层仍保守 failed，JSON 独立返回 response/error/guidance。旧 AGY ERROR 汇总读取时不覆盖实际正文，其他 CLI 折叠规则不变。
- [Issue #2](https://github.com/SuperWheel/dsh-cliworker-now/issues/2)：完成的空/纯空白 assistant 不生成消息块，过程区保留其 Token、时间、步骤耗时；活动流式、工具和错误保留。最后可见回复功能条跳过隐藏空步骤，本轮时间与 CLI 会话累计耗时/用量分别展示，不重复相加。
- 最小回归（命令均加 `pnpm --config.verifyDepsBeforeRun=false`，避免现有 pnpm 环境触发依赖重装）：`test tests/agy-run-outcome.test.ts tests/core.test.ts tests/adapters.test.ts` 85/85；`test tests/telemetry.test.ts` 10/10；`test tests/conversation-timeline.test.tsx` 10/10；`test tests/panel.test.tsx -t 'uncertain AGY|keeps .* filtering|leaves the recycle view'` 8/8（53 项名称过滤未执行）；Panel 原生历史/streaming tail 两项定向 2/2（59 项过滤未执行）。合计 115 个不同的相关用例通过，没有运行全量测试。
- Host/Client `typecheck` 通过；最终 `build:preview` 通过，preview 的 139 个源文件与当前 src 字节一致，版本 0.7.9。Host SHA-256 `95cd82fd8ce63381fdae3229eafc90f233f8a019f6ff04d403a447a7612653c0`；Client `1f93222f6c95b57670c902f34983541588c74d3a40ed393f7b2c497f464b537f`。仅隔离包 `.cache/preview-package`，未运行正式 build。
- Tabbit 实际渲染使用真实 ConversationTimeline、MarkdownText、UsageIndicator 和生产样式，输入全部明确标注模拟。六模式覆盖完成空步骤、空流式、正文流式、失败空输出、结果待核实、历史页：完成模式 2 个 article/0 空 assistant、过程 3 个统计行；步骤 Token 23/11/7 可查看，本轮 5 秒与累计 4100 秒独立，最终总用量保持 410 tok；末条 tail=always，流式及历史 tail=hover。截图逐张视觉核查通过。证据 `.cache/agy-issues-v079/{verification.json,completed.png,process.png}`；可复现夹具 `.cache/issue-2-ui/`。
- 中间检查如实保留：pnpm 初次自动检查依赖因无 TTY 中止，改为既有配置开关，无安装/清理依赖；新测试初跑两处断言使用不当已修正（undefined 的 not.toContain 和两个同类统计控件的选择范围），重跑通过；隔离 UI 初次 bundle 缺少 automatic JSX 导致 React is not defined，修正夹具构建并补齐生产样式后刷新，无脚本错误。独立审查发现空/纯空白 result 会话 ID 可能进入 uncertain，已在 parser 严格拒绝并在 runtime 二次比对，补协议及运行时回归，复审无剩余确定问题。
- `spec:check` 归档前后均 15/15 通过，差异检查通过；本 change 的规格、实现和最小验收完成后同步归档，既有三个未完成 change 保持原状态。没有 Windows 实机、真实 CLI/模型、正式 Desktop 更新、全量验收、GitHub 推送/评论/关闭 issue 或发布；浏览器模拟不等同于这些实机验收。既有图标归档、宣传资料与历史文档改动保留。

## 2026-10-15：v0.7.9 轮后续聊与模型快选最小验收

- 已实现 Host 持久待发送队列、正常结束后 FIFO 续聊、取消/暂停/显式恢复，失败/停止/uncertain/重启保留未发送内容。停止等待发送前原生查询清理；真正执行前重新核验账号/模型及父会话权限。输入运行中可编辑，成功响应不覆盖后来草稿；用户最终要求的单一动作按钮已落实：空草稿停止，有文本发送，二者不并排。
- 已实现首次派遣保存目录、Worker 同来源缓存读取、菜单预取复用及选择时本地保存。原生会话 ID 保持；没有依据添加“换模型必然丢失上下文”弹窗。发送时原生授权继续，失效不静默回退。
- 公开过程接入 Codex、Claude、Pi、OMP、Grok，协议来源及未支持范围见 [public-process.md](public-process.md)。只显示原生公开文本与计划，不提取隐藏推理。
- 所有命令加 `--config.verifyDepsBeforeRun=false`，避免 pnpm 触发与本次无关的依赖重建。缓存/设置/core 三个关联测试文件 69 项通过；Panel 全文件在初版测试按钮名修正后 66 项通过，随后新增 metadata 取消用例通过，并对最终单按钮行为定向回归 3 项通过（最终文件共 67 项；未把重复运行累加成新增覆盖）。
- `tests/followup-queue.test.ts tests/runtime.test.ts tests/agy-run-outcome.test.ts tests/storage.test.ts tests/cleanup-persistence.test.ts` 共 69 项通过，其中队列新增 15 项覆盖 FIFO、身份/账号、去重、停止清理、重启、uncertain、取消、执行前拒绝保留、目录等待后权限变化及文件边界。
- `tests/public-process.test.ts tests/conversation-timeline.test.tsx tests/grok-adapter.test.ts tests/adapters.test.ts` 共 47 项通过；Pi/OMP 相关定向测试 4 项通过（其余 52 项按名称未运行）。首次 Pi/OMP 合成回环服务器受沙箱 EPERM 阻断，获准本机监听后重跑通过；没有真实模型请求。
- 独立审查修复了：停止在元数据查询中提前返回、outbox 读取链接边界、runtime 等待后权限变化、metadata 准备阶段 UI 无取消出口。最终没有剩余确定性 Host 问题。
- `pnpm ... build:preview` 最终通过；在隔离包内运行 `pnpm ... typecheck`，使用本次生成的 Remote 声明，Host 和 Client 均通过。全部 src 与最终预览源逐字节一致。正式 lib 不修改，避免热更新已安装插件。构建仅保留既有 CommonJS 建议提示。
- Tabbit 使用真实 Panel/ConversationTimeline/原生控件、明确模拟 Gateway：运行中打字与 Enter 入队、继续草稿、暂停/显式恢复/取消、模型及强度快选（目录读取 1 次、偏好保存 2 次、任务启动 0 次）、公开摘要安全文本、无摘要提示均已实际渲染核对；最终按钮数始终为 1。320 px 窄栏 clientWidth/scrollWidth 均为 320，按钮可见。夹具与证据在 `.cache/followup-ui/`，`single-action.png` 为最终界面，`verification.json` 记录范围与哈希。模拟渲染不等于安装后的 Desktop 验收。
- 版本仍为 0.7.9。未执行真实账号/模型、Windows 实机、正式 Desktop 更新、全量测试、GitHub 推送或发布。全量验收只在获准的正式 GitHub 提交前执行。
