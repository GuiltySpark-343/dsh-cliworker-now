# DSH 0.2.1-rc.3 原生会话扩展

官方 tag `dsh-v0.2.1-rc.3` 固定于 `1f81c047fc48fa190a683e469daa699857e9afe8`。官方 app 的 client-modules 构建标记为 `be72761`；2026-10-24 GitHub commit API 返回 No commit found，未解析为公开提交，不等同 tag。

沿用 rc.2 的四包与 slot 文档 48 文件扩展。skeleton 测试冲突手工合并，保留 rc.3 header hooks、views.actions、view-pins、whenDraftExists 和提交快照，同时保留 commandSource、childImageUploads 相关回归。旧 rc.2 目录及产物保留。

## 隔离重建

所有命令从插件根执行；使用项目 pnpm，禁用依赖安装脚本。先克隆真实 tag checkout 到 `.cache/dsh-host-source-021rc3` 并应用 source.patch。将 build-dependencies 三文件复制到 `.cache/dsh-host-build-deps-021rc3`，执行 `pnpm --dir .cache/dsh-host-build-deps-021rc3 install --ignore-scripts --frozen-lockfile --store-dir <repo>/.cache/dsh-host-pnpm-store-021rc3`。dependency-links.json 记录实际安装元数据与同版源码别名；根依赖先按插件锁文件安装。

```sh
node scripts/build-host-extension.mjs --target 0.2.1-rc.3 --prepare-links
node host-extensions/dsh-0.2.1-rc.3/check-client-types.mjs
node scripts/build-host-extension.mjs --target 0.2.1-rc.3
node scripts/build-host-extension.mjs --target 0.2.1-rc.3 --verify
node scripts/vendor-host-extensions.mjs --from artifacts/dsh-host-extension-021rc3-data
```

四包官方 Host/声明继承同版 npm 基线，新增扩展类型由源码检查验证；浏览器重新构建。runtime-host 中仅归一化生成注释、不携带 source map。上述命令不安装或启动官方 app；实际验证、兼容范围与未验证边界见 doc/tasks.md。


## 回归检查

隔离依赖显式固定 React/React DOM 18.3.1、Zustand 4.4.7 与 use-sync-external-store 1.2.0，防止根目录和隔离目录产生两份 React。四包测试使用上游原始 Vitest 配置，在 `.cache/dsh-host-source-021rc3` 执行：

```sh
node node_modules/vitest/vitest.mjs run packages/client/ui-session/tests packages/client/ui-conversation/tests packages/client/ui-subagent/tests packages/client/ui-chat/tests --maxWorkers=4
```

历史补丁中的七处统计文案断言仍要求此前已移除的解释文字；本次同步为既有“—”未知值及精简弹层合同，保留金额、零值、原生交互和来源校验。生产实现不因此变化。
