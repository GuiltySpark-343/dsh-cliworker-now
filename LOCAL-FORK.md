# 这是 dsh-cliworker-now 的本地分支（基于 v0.8.3）

- 上游：<https://github.com/SuperWheel/dsh-cliworker-now>
- 基线：`v0.8.3`（提交 `b5c9099`，含上游全部历史）
- 本分支：`main` = 基线 + 14 个本地提交；`upstream-0.8.4` = 官方 0.8.4 原样快照

## 本分支新增

### 1. 会话级「可用智能体」（模板）

- 在面板第五个视图「可用智能体」里，从角色卡片创建**模板**：固定 CLI、模型、思考强度、角色提示词
- 主会话派遣时传 `template`，每次创建一个**带编号的新实例**（`模板1`、`模板2`…），不再弹选型卡，同一模板可反复创建
- 编号由宿主分配（最小空闲号）；**删除 Worker 会释放名称**，编号可复用
- 删除 = 归档，恢复时同名被占用会自动改成 `名字-1`，不会出现重名
- 面板行显示「已创建 N 个」；`cliworker_status` 返回模板及其实例；系统提示词只做存在性提示
- 模型清单只读「设置 → CLI 连接」已探测的缓存，不启动 CLI、不查账号

### 2. Worker 执行次数

每个 Worker 每开始一轮累加 `runCount`，面板显示「第 N 次」。

### 3. Codex 第三方中转授权（marker 门控）

`~/.dsh/cliworker-now/codex-custom-provider.txt` = `1` 且 Codex `config.toml` 声明了 `[model_providers.*]` 的 `base_url` + `experimental_bearer_token` 时，按「已声明 provider 路由」生成授权绑定，不再报「无法确认当前自身账号」。默认行为不变。

> 官方 0.8.4 已原生支持该场景；合并 0.8.4 时本补丁可退役。

### 4. 安装脚本

`scripts/install-local.mjs`：构建 → 按发布形态打包 → 备份现有安装 → 覆盖 profile 包（保留其 `node_modules`）。

## 构建与安装

```bash
pnpm install
node scripts/build.mjs
node scripts/install-local.mjs     # 装进 ~/.dsh/profiles/web/node_modules/dsh-cliworker-now
# 完全退出并重启 DSH
```

也可以直接安装 Release 里的预构建包：

```bash
dsh plugin --profile web add ./dsh-cliworker-now-0.8.3-local.1.tgz
```

要求：Node ≥ 22.19，DSH 0.2.1-rc.2 / rc.3。

## 与官方 0.8.4 的关系

官方 0.8.4（2026-10-27）新增了账号登录窗口、通用设置页（界面语言 / 并发上限 / 同目录写并行 / 调用前询问模型）、隔离副本 + 三方合并、换号续接、Codex 中转原生支持、中英文 i18n 等。

后续合并原则：

- **功能相同的用官方实现**：Codex 中转、同目录写并行、i18n
- **本分支独有的保留**：会话级模板（roster/template/编号/名称释放/面板第五视图）、`install-local.mjs`、`runCount`
- 合并顺序：`git fetch origin`（origin 指向官方）→ merge `origin/main` → 按补丁重放模板相关提交 → typecheck/测试/安装验证

## 数据目录

`~/.dsh/cliworker-now/`：`roster-*.json`（模板）、`*.worker.json`（Worker 记录）、`settings-catalogs/`（模型目录缓存）、`backups/`（安装备份）。

标记文件：`codex-sandbox.txt`（Codex YOLO）、`claude-permission.txt`（Claude YOLO）、`codex-custom-provider.txt`（Codex 中转）。取消 YOLO 用环境变量 `CLIWORKER_CODEX_SANDBOX=stock` / `CLIWORKER_CLAUDE_PERMISSION=stock`。
