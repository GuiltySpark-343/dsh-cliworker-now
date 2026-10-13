# GitHub Release 正文模板

沿用 [v0.7.7 Release](https://github.com/SuperWheel/dsh-cliworker-now/releases/tag/v0.7.7) 的正文结构。此文件是项目发布文档，供后续版本复用。

- Release 标题统一为 `dsh-cliworker-now vX.Y.Z`，Tag 为 `vX.Y.Z`；将 `X.Y.Z` 替换为本次版本号。
- 正文依次为 `## vX.Y.Z`、一段简介、`### 更新`、`### 安装或更新`、`### 验证`。更新与验证使用一层项目符号，不嵌套。
- 简介说明本次解决的问题；更新项按最终交付行为撰写，不照搬历史版本内容或放入内部实施过程。
- 推荐命令保持单行，使用已验证的 `@latest`；发布时核对 npm `latest` 指向本版。tgz 备用链接固定到本次版本，不另加第二个安装代码块。
- 冻结安装包前核对公开 `package.json` 的 `repository`、`homepage` 和 `bugs` 均指向 `SuperWheel/dsh-cliworker-now`，发布后从 npm 固定版本元数据回读。仓库改名不会改写已发布包；v0.7.8 保留原包，旧链接按用户确认留待下一次获准发布时更新，不为改链接撤包或擅自升号。
- 验证数字、CI 链接、文件数量、包哈希及实际交互均从本次证据填写。没有执行的项目删除对应通过描述，并明确未验证范围；不复制旧版本数字或把模拟、目录读取、安装成功写成真实模型生成成功。
- 发布前替换全部占位符。正文不得包含私人路径、账号标识、凭据或个人运行日志。

## 可复制正文

Release 标题：`dsh-cliworker-now vX.Y.Z`

````markdown
## vX.Y.Z

<用一段话说明本次版本解决的问题和带来的使用变化。>

### 更新

- <功能或模块>：<具体触发场景及更新后的行为>。
- <功能或模块>：<本次新增或修复；保留必要的能力边界>。
- <功能或模块>：<本次实际交付内容>。

### 安装或更新

先结束活动任务并完全退出 Harness，再执行：

```sh
dsh plugin --profile desktop add dsh-cliworker-now@latest
```

此命令按安装器当前规则解析 npm 的 `latest`；启动 Harness 本身不会自动更新插件。pnpm 11 默认等待新版本发布满 24 小时，期间可能保留旧版，请核对实际安装版本。完成后重新打开 Harness。无需克隆或构建项目。

也可使用本版[预构建 tgz](https://github.com/SuperWheel/dsh-cliworker-now/releases/download/vX.Y.Z/dsh-cliworker-now-X.Y.Z.tgz) 作为安装来源。无需克隆或构建项目。

### 验证

- macOS 完整回归：<通过数> 通过、<跳过数> 跳过、<失败数> 失败；<本次实际执行的类型检查、隔离构建、正式构建和规格校验结果>。
- Windows 完整回归：<通过数> 通过、<跳过数> 跳过、<失败数> 失败；<平台专属跳过原因及对应验证范围>。
- [GitHub CI](https://github.com/SuperWheel/dsh-cliworker-now/actions/runs/<run-id>)：<本次检查结果与实际覆盖范围；仅在 CI 提供测试统计时填写数字>。
- macOS / Windows 实际 Desktop：<本次实际核验的安装版本、设置交互、账号状态或进程生命周期结果>。
- 独立 profile 的固定 npm 版本安装：<安装版本、Host 加载结果及文件核对结果>；`@latest` 从 <旧版本> 升级至 vX.Y.Z：<实际核对结果>。
- GitHub Release 与 npm 公开安装包：<远端下载核对结果>；SHA-256：`<本次公开包的 64 位哈希>`。包不包含账号凭据、私人连接配置或运行日志。
- 未验证范围：<本轮未执行的真实账号、订阅、CLI 或模型调用，以及保留的已知限制>。安装与目录读取不代表所有第三方模型的真实生成均已验证；账号和额度限制仍由各 CLI 管理。
````
