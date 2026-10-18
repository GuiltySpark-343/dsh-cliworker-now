# DSH 0.2.1-rc.2 可选原生会话扩展

此目录移植此前已授权的完整原生侧栏呈现及会话统计来源接口，不扩大宿主权限或替换用户配置。旧 `dsh-0.2.0-rc.2` 保留。

官方公开 tag `dsh-v0.2.1-rc.2` 的源码 commit 为 `687f282e8625c6b8d11ff58211a90524be2e4317`。实际 Desktop 的 build stamp 为 `332895e0f7c9d4dbfb29729f5eb367fa263ff986`，该对象不在公开仓库，不能声称两个 SHA 相同；实际安装四个 client.js 已与官方同版本 npm 对照：ui-session 字节一致，其余仅生成 CSS namespace 和 source region 路径不同，规范化后代码与样式一致。

只修改 ui-session、ui-conversation、ui-subagent、ui-chat 及相应 slot 文档。`provideProjections` 仍按真实 SessionReference/绑定代际接受独立 observable 并清理订阅；普通会话没有来源时走原路径。外部每轮账单、unknown/estimated、上下文分类/来源、运行中状态及已证明历史最终回复顺序沿原合同保留，不生成缺失公开过程。

适配保留新版 `conversation.chat.flow` 及 keyed rows/group actions，外部 process proof 在该 flow 内投影；保留新版分别注册的 ActivityPill/UsagePill 和原生 dialog 生命周期，只添加可选外部来源/未知显示。不恢复旧 ChatNodeList，不把旧 StatsPills 布局覆盖新版。新的 group-tree 位置判定代替旧独立节点 kinds 常量，保持新版节点的原生分组语义。

## 隔离构建

依赖仅位于 `.cache/dsh-host-build-deps-021rc2`，内容地址store独立位于 `.cache/dsh-host-pnpm-store-021rc2`。`build-dependencies` 为冻结输入。`dependency-links.json` 逐个记录依赖身份/hash；允许读取根既有依赖，但不会修改它们。下载均为官方发布包，安装时禁用 lifecycle scripts。

```sh
# 官方源码固定到上述 release tag；不要以安装版本 buildStamp 冒充公开 Git commit。
git clone --branch dsh-v0.2.1-rc.2 --single-branch https://github.com/deepseek-ai/deepseek-harness.git .cache/dsh-host-source-021rc2
git -C .cache/dsh-host-source-021rc2 apply ../../host-extensions/dsh-0.2.1-rc.2/source.patch
node scripts/build-host-extension.mjs --target 0.2.1-rc.2 --prepare-links
node host-extensions/dsh-0.2.1-rc.2/check-client-types.mjs
node scripts/build-host-extension.mjs --target 0.2.1-rc.2
node scripts/build-host-extension.mjs --target 0.2.1-rc.2 --verify
```

准备依赖需将三个build-dependencies文件复制到新隔离目录，再使用已有pnpm执行带独立store-dir的 `install --ignore-scripts`。禁止在根仓库或用户profile执行该安装。四包 artifact 继承官方同版本 Host入口及声明，仅重编 client；新增可选接口的类型由源码检查，未冒称继承声明包含扩展接口。当前候选需由root核对manifest、隔离preview和最终Desktop验收，再协调安装窗口；本构建命令不安装或重启。

## rc.1 → rc.2 最小移植

官方两个 release tag 在这四包及 slot 文档范围仅四个 package.json 的版本从 rc.1 改为 rc.2，源码没有行为差异。已授权46文件补丁的生产实现原样适用；一项旧测试仍引用已拆分的 StatsPills，将其更正为实际原生 UsagePill 后完整通过。此前移植 source.patch SHA256为4fae27561e85de3e77d0b3c89ef219b27386ea0bcd056ff55b9337af7117a5db。此次独立冻结新SDK依赖、重新类型检查/构建/回归，不扩大接口或移动旧原生产物。

## Qoder 统计回归补充（2026-10-17）

当前 source.patch SHA256 为 `c6e406fa80f64e2e44de903308725f4a0eae1dc9ffafae635a0ec4271d86b6bd`，仍仅涉及既有四包及其文档范围。ContextMeter 接受可选原生比例，token 数和容量可同时未知；ActivityPill 说明 Harness 调 CLI 的统计口径；外部用量新增中性的 `reported` 输入口径，不推断缓存。未提供外部元数据的普通会话沿用原生行为。新候选输出在 `artifacts/dsh-host-extension-021rc2-regressions`，完成预览后才按空闲门禁更新已链接产物，实际安装状态见 `doc/tasks.md`。
