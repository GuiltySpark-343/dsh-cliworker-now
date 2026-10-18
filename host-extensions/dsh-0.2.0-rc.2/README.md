# DeepSeek Harness rc.2 原生对话扩展

这是经用户批准、安装前验收的宿主 Client 扩展。它只重建 `@deepseek-ai/dsh-client-ui-session`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-subagent`、`@deepseek-ai/dsh-client-ui-chat` 四包的浏览器入口；不安装 Desktop、不修改已安装包、会话、CLI 账号或配置。

上游：<https://github.com/deepseek-ai/deepseek-harness>，tag `dsh-v0.2.0-rc.2`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`。`source.patch` 包含四个 UI 包的源码、相关测试/文档，以及 slot 文档。普通会话的入口、按钮和数据来源默认行为不变；共享 ContextMeter 统一修复低于 1% 的显示精度，图形使用未取整比例。扩展为完整原生子对话提供可选主对话按钮呈现、命令来源传递及精确会话作用域的投影来源。

## 构建

从仓库根目录执行。需要本项目锁定的依赖，以及官方 rc.2 源码 checkout；构建使用官方 `packages/client/tsdown.client.ts` 的 `clientBundle`，经 `tsx` 导入，并只调用浏览器配置。没有另写 webpack/esbuild 兼容实现。

```sh
# 在新机器上准备依赖；这不是安装或更新 Desktop。
pnpm install --frozen-lockfile
mkdir -p .cache/dsh-host-build-deps
cp host-extensions/dsh-0.2.0-rc.2/build-dependencies/package.json .cache/dsh-host-build-deps/
cp host-extensions/dsh-0.2.0-rc.2/build-dependencies/pnpm-lock.yaml .cache/dsh-host-build-deps/
cp host-extensions/dsh-0.2.0-rc.2/build-dependencies/pnpm-workspace.yaml .cache/dsh-host-build-deps/
pnpm --dir .cache/dsh-host-build-deps install --frozen-lockfile

# 以下 clone/apply 只用于新的隔离源码目录；已应用的目录不要再次 apply。
git clone --branch dsh-v0.2.0-rc.2 --single-branch https://github.com/deepseek-ai/deepseek-harness.git .cache/dsh-host-source-rc2
git -C .cache/dsh-host-source-rc2 rev-parse HEAD
git -C .cache/dsh-host-source-rc2 apply ../../host-extensions/dsh-0.2.0-rc.2/source.patch
node scripts/build-host-extension.mjs --prepare-links
node scripts/build-host-extension.mjs
node scripts/build-host-extension.mjs --verify
```

macOS 本地 Git 使用 `/Library/Developer/CommandLineTools/usr/bin/git`；构建脚本已固定该路径。依赖映射记录在 `dependency-links.json`，每项包含包版本、锁定安装路径和 package.json SHA-256。`--prepare-links` 只在仓库 `.cache` 内的隔离 checkout 创建缺失链接，遇到不同的现有链接会拒绝；不会改写原依赖包。当前映射来自 macOS arm64 的实际依赖安装，其他平台尚未验收，不把缺少的平台依赖静默替换。

额外构建依赖的三个文件必须在安装前一起复制。其独立 `pnpm-workspace.yaml` 仅包含 `packages: ['.']`，让该目录成为自己的工作区，防止 `pnpm --dir` 向上查找并改动仓库根工作区或锁文件。构建及 `--prepare-links` 都会核对这三个文件与受版本管理输入一致；缺失或不一致时停止，不自动安装或修改锁文件。

源码迭代后须先完成评审与冻结，再用 `node scripts/build-host-extension.mjs --export-patch` 更新补丁。脚本拒绝错误 HEAD/tag、未纳入补丁的新文件、越界改动或补丁不一致。`--source <checkout>` 指定其他源码目录；`--out artifacts/<name>` 保留独立候选产物。只有显式 `--replace` 才替换已有产物，且不会访问 artifacts 之外的目标或沿符号链接覆盖文件。

## 产物与声明边界

默认产物位于 `artifacts/dsh-host-extension-rc2/`。各包目录沿用 `dsh-client-ui-*` 名称。已装官方 npm 包的 `lib/index.js`、package metadata、原有 types 和其他 lib 文件保持逐字节一致，只覆盖新构建的 `lib/client.js` 与 map。

**本次没有生成扩展版 `.d.ts`。** 产物中的声明继承官方 rc.2，尚未描述新增 `SessionProjectionSources`、`provideProjections` 、externalTurnUsage 或新增 owner props；不得将其当作新增接口的完整类型 SDK。新增接口的准确源码在补丁内。浏览器运行时构建、源码/插件回归与完整宿主类型重编是不同验证项目。

`manifest.json` 记录上游、补丁、工具链、四个包的官方基线文件哈希、Client 哈希和全部产物文件清单。`build-inputs/` 保存本次构建脚本、补丁、依赖映射、两份锁文件，以及额外构建依赖的独立 `extra-build-pnpm-workspace.yaml`。`--verify` 检查文件数量、大小和 SHA-256，并核对当前受版本管理补丁。源码映射嵌入原始源码。重复构建应比较四个 client.js/map 的哈希；manifest 不包含时间戳。

## 验收与回退

构建成功只证明生成了可校验候选包，不代表浏览器、Desktop 或真实 CLI 验收通过。先由隔离浏览器验证完整原生侧栏与默认行为，再在无活动任务时单独决定安装；本脚本没有安装命令，也不会改动原 node_modules 或 Desktop。

验收和正式装配均应使用 profile 的合法 Loader 条目：先将原 `ui-session`、`ui-conversation`、`ui-subagent`、`ui-chat` 四行设为 `disabled: true`，再用 `insert` 增加四个**不同 id** 的扩展入口。官方 rc.2 的这四行均没有 `config`；若目标 profile 另有配置，应审阅并复制到对应新行。示例中的绝对路径须换成已验证的独立扩展目录：

```yaml
- id: ui-session
  disabled: true
- id: ui-conversation
  disabled: true
- id: ui-subagent
  disabled: true
- id: ui-chat
  disabled: true
- insert:
    - id: cliworker-host-extension-session
      name: /absolute/verified-extension/dsh-client-ui-session/lib/index.js
    - id: cliworker-host-extension-conversation
      name: /absolute/verified-extension/dsh-client-ui-conversation/lib/index.js
    - id: cliworker-host-extension-subagent
      name: /absolute/verified-extension/dsh-client-ui-subagent/lib/index.js
    - id: cliworker-host-extension-chat
      name: /absolute/verified-extension/dsh-client-ui-chat/lib/index.js
```

`{id, name}` 中的 `name` 是匹配校验条件，不是重命名操作；不能用它直接覆盖原行。也不能同时启用官方和扩展的同名包。启动后必须核对 Loader 活动来源，以及 `clientModules.clientPath(packageId)` 的路径和哈希，确认五个 Client 入口分别来自这四个扩展包和精确 CLI Worker 候选。

放在另一个包目录下的独立验收 `.mjs` 必须有自己的 `package.json`（独立 name、private、type:module，且不声明 dsh.client），否则官方最近祖先 manifest 解析会将其错误归入外围包，产生第二个浏览器模块来源。不要通过改写 clientModules 来绕过这个归属问题。

安装负责人须保存原 profile patch、扩展完整目录和哈希、精确 CLI Worker 候选及旧版本信息。回退时先退出 Desktop、确认无活动任务，撤销四个新增扩展行并恢复四条原行的原始 disabled/config 状态，同时恢复相匹配的 CLI Worker 候选，随后冷启动。官方 npm 包全程保留；若另行选择了物理替换包目录的安装方式，则还须恢复安装前保存的完整目录并核对 `manifest.packages[].baselineFiles`。扩展不改写会话格式、CLI 账号或用户配置，无需迁移或删除历史。

后续候选加入 `ui-chat` 的原生每轮用量、请求状态及严格验证的历史答案位置来源，默认缺省维持原版行为。完整 CLI run 合计由精确 turn/run 关系提供，使用原有 TurnUsagePanel；历史过程和答案沿用原生节点与状态，展开后过程位于答案上方，不伪造模型响应或改写事件。当前候选目录为 `artifacts/dsh-host-extension-rc2-answer-order/`；此前候选作为历史和回退保留。具体安装状态、包哈希和验收边界以 `doc/tasks.md` 的最新记录为准，构建目录存在本身不代表安装通过。
