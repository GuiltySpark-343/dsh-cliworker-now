# dsh-cliworker-now 的 dshfind 改名与下载量同步

已提交 [dshfind PR #51](https://github.com/hikariming/dshfind/pull/51)，仍待维护方合并、迁移与刷新。DSH 内插件界面名称保持原样。

本方案仅针对 `SuperWheel/cliworker-now` → `SuperWheel/dsh-cliworker-now`。尚未写入 dshfind 数据库或更新其公开页面。

## 已核验身份与补丁范围

- GitHub 新旧地址指向同一仓库：repository id `1407409202`，node id `R_kgDOU-NcMg`。规范地址为 <https://github.com/SuperWheel/dsh-cliworker-now>。
- npm 包名保持 `dsh-cliworker-now`。已发布包保留历史 repository URL；改名本身不会改变包内容或下载量。
- 补丁只新增这一条页面重定向映射，并让 npm 回链核验仅对此已核验别名使用现有映射。其他仓库及其他既有别名仍遵循精确回链规则。
- 没有修改下载探测脚本、星数门槛、调度或统计口径。`--only` 已能绕过本条目的低星数与新鲜度筛选。
- 独立安装辅助函数回归 `44 passed / 0 failed / 0 skipped`，Node `v22.23.1`；站点现有工作流使用 Node 24。本方案未运行数据库维护脚本或全站构建。

## 官方 dry-run 的边界

`rename-plugin.mjs --dry-run` 需要有权限读取新旧 D1 条目，输出迁移计划，但会在数据库写入及 `recordRename()` 前退出，因此不会生成 `src/lib/plugin-renames.ts` 的映射。这里的映射由同 repository id 的公开证据手工准备，可通过普通代码 PR 审阅。

完整迁移仍由站点维护者执行。普通公开 API key 只提供查询配额，GitHub 插件作者身份不等于 D1 写权限。维护者需要配置 `D1_INTERNAL_URL` 与 `D1_INTERNAL_TOKEN`；不应将值放入 PR、日志或本说明。

## 维护者执行顺序

以下命令在已合并补丁、已配置维护环境的 dshfind 仓库执行；推荐 Node 24。先检查新旧条目，再迁移，最后重新探测，不填写臆造统计。

```sh
pnpm sync:db --only SuperWheel/dsh-cliworker-now --skip-contributors
node --env-file=.env.local scripts/rename-plugin.mjs SuperWheel/cliworker-now SuperWheel/dsh-cliworker-now --dry-run
```

核对 dry-run 的身份、条目及迁移计划无误后执行：

```sh
node --env-file=.env.local scripts/rename-plugin.mjs SuperWheel/cliworker-now SuperWheel/dsh-cliworker-now
pnpm probe:install --only SuperWheel/dsh-cliworker-now
pnpm probe:downloads --only SuperWheel/dsh-cliworker-now
pnpm readmes:fetch --only SuperWheel/dsh-cliworker-now
```

官方迁移脚本搬迁运营标记、下载数据组、翻译、历史快照等，并软删除旧行；`plugin_readmes` 不在其迁移列表中，所以单独抓取新名 README。`probe:downloads --dry-run` 不适合当作无授权试运行：现有脚本仍先执行 schema 补列操作；未取得 D1 权限时不要运行任何该维护脚本。

若站点维护者决定优先显示已经验证的 npm 安装命令，可使用既有单条目覆盖：

```sh
node --env-file=.env.local scripts/set-plugin-i18n.mjs SuperWheel/dsh-cliworker-now --install-cmd="dsh plugin --profile desktop add dsh-cliworker-now@latest"
```

执行前确认 npm `latest` 已指向实际公开版本。开发仓库的 `package.json` 为 `private: true`：现有安装探测会跳过 npm 发布查询并采用已验证 Release 来源；这份补丁不改变该全站策略。下载探测优先使用数据库中的 `pkg_name`，本条已记录 `dsh-cliworker-now`，所以经别名回链核验后仍可采集 npm 下载量。手动安装命令覆盖不会自动改写所有 npm 探测或桌面端安装证据字段，不能将其宣称为完整 npm 探测通过。

随后按站点现有发布流程刷新快照与 API 产物并部署，核对重定向映射 diff。页面匿名缓存策略为一小时；数据库已更新不代表原缓存响应立即变化。不要以刷新网页替代数据库及部署核验。

## 数据口径及公开证据

2026-10-10 至 2026-10-13 的只读下载快照：npm 官方 `462`、npmmirror `25`。按站点 npm 渠道口径为 `487`；GitHub 全部 Release 资产为 `29`，独立保存，不与 npm 渠道混加，也不解释为独立用户或安装次数。详情徽章仅显示档位，`487` 对应 `200+`。维护者应重新执行探测获取当时数据，不把本快照硬编码为覆盖值。

- npm：<https://api.npmjs.org/downloads/point/2026-10-10:2026-10-13/dsh-cliworker-now>
- npmmirror：<https://registry.npmmirror.com/downloads/point/2026-10-10:2026-10-13/dsh-cliworker-now>
- GitHub：<https://api.github.com/repos/SuperWheel/dsh-cliworker-now/releases>
- 改名前目录 API：<https://api.dshfind.com/v1/plugins/SuperWheel/cliworker-now>
- 官方迁移实现：<https://github.com/hikariming/dshfind/blob/main/scripts/rename-plugin.mjs>
- 官方下载探测：<https://github.com/hikariming/dshfind/blob/main/scripts/probe-downloads.mjs>
- 展示口径：<https://github.com/hikariming/dshfind/blob/main/src/lib/downloads.ts>

## 更新后核对

- 新目录条目确认为 `SuperWheel/dsh-cliworker-now`；旧详情及旧徽章地址按已部署映射跳转，历史与运营数据不丢失。
- 安装版本及来源不再停留在 `0.6.5`；npm 手动命令、Release 备用来源及桌面端目录证据各按实际状态报告。
- `dl_pkg`、`dl_npm_total`、`dl_mirror_total`、`dl_release_total`、`dl_status`、`dl_probed_at` 来自本轮真实采集，未把包名别名误记成 `name-taken`。
- 页面下载展示按 npm+镜像优先、Release 备用的既有口径；未用手工总数伪造或固定增长。

## PR 可交付与仍需维护权限的部分

可以通过 PR 交付三文件补丁：重定向映射、本条 npm 回链兼容及回归测试。PR 合并和部署可提供代码层能力，但不会执行 D1 主键迁移或统计采集；上述数据库操作与产物部署仍需有权限的站点维护者完成。没有此权限时只能交付方案与补丁，不能声称公开页面已经更新。
