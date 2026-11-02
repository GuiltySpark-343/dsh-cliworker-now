# dsh-cliworker-now 本地分支（基于官方 v0.8.5）

- 上游：<https://github.com/SuperWheel/dsh-cliworker-now>
- 基线：`v0.8.5`（提交 `31ce1b0`）
- 本分支在官方 0.8.5 之上移植了我们自己的功能；官方已有等价实现的（工具失败语义、输出截断、Codex 中转、权限档位）直接使用官方实现。

## 相对官方新增

### 1. 会话级「可用智能体」（模板）

- 面板第五视图「可用智能体」：从角色卡片创建模板，固定 CLI、模型、思考强度与角色提示词
- 主会话派遣时传 `template`，每次创建一个**带编号的新实例**（`模板1`、`模板2`…），不再弹选型卡，同一模板可反复创建
- 编号由宿主分配（最小空闲号）；删除 Worker 释放名称，编号可复用
- 删除 = 归档；恢复时若同名已被占用，自动改成 `名字-1`
- `cliworker_status` 返回模板清单、实例数量与名称；系统提示词只做存在性提示
- 模板数据仍在 `~/.dsh/cliworker-now/roster-<会话哈希>.json`（与旧分支兼容）

### 2. 运行日志按项目存放

- 时间线与原始流写入 `<项目>/.dsh/cliworker-now/logs/`，自动生成 `.dsh/.gitignore`（`*`）
- 项目不可写时回退全局目录；旧日志读取回退并自动迁入项目
- 保留策略：每 Worker 最近 20 轮 / 全局 512 MiB，运行中不删
- 配置：`logsDirectory: project|global`、`rawRetentionRuns`、`rawRetentionBytes`

### 3. 原始日志查看

- 任务菜单「查看原始日志」：只读返回该轮文件尾部（1 KiB–1 MiB，默认 256 KiB），显示字节数与是否截断

### 4. 「过程已截断」标记

- 本轮展示内容被预算截断时，Worker 记录 `displayTruncated`，卡片显示「过程已截断」，下一轮开始时清除
- 原始流仍然完整落盘，可从「查看原始日志」回溯

### 5. 执行次数

- 每个 Worker 每开始一轮累加 `runCount`，卡片显示「第 N 次」

### 6. 安装脚本

- `scripts/install-local.mjs`：构建 → 按发布形态打包 → 备份现有安装 → 覆盖 profile 包（保留 `node_modules`）

## 构建与安装

```bash
pnpm install
node scripts/build.mjs
node scripts/install-local.mjs     # 覆盖 ~/.dsh/profiles/web/node_modules/dsh-cliworker-now
# 完全退出并重启 DSH
```

要求：Node ≥ 22.19；宿主 DSH 0.2.1-rc.5（官方 0.8.5 的目标宿主；rc.3 上官方包可运行，但未做完整回归）。

## L2 事件降量：由官方实现覆盖

0.8.3 的 L2 做过 120ms / 8 KiB 合并、只镜像尾部等优化。0.8.5 的架构已经把这些目标内置了：

- 进度只传**增量**（`delta`），完成消息携带一次完整输出，不再每帧累计重发
- 原生镜像帧用 `cliworkerOmitted` 占位，去掉重复载荷
- 展示预算（`maxRunBytes` / `maxToolPreviewBytes`）只截断展示并标 `truncated` / `outputBytes`，不终止 CLI
- 官方测试 `native-output-budget` / `native-primary-runners` 明确断言"传输字节与正文线性相关"（< 12×）

因此本分支**不再移植 0.8.3 的合并/尾部镜像**：那会改变官方已测试的逐增量契约，收益只是减少事件行数。

## 未移植的部分

- `parallel_write` 单标志放行：官方 0.8.5 用隔离副本 + 三方合并，语义更强，直接使用官方实现
- Codex 自定义中转绑定补丁：官方已原生支持
- L1/L4（超限截断、工具失败语义）：官方 0.8.5 已有等价实现
- L2 的合并/尾部镜像：官方以"增量传输 + 预算截断"实现同一目标，见上文
- 子会话释放：DSH 子智能体列表是 append-only 历史，官方同样不做清理
