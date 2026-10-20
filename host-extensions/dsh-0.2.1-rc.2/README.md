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

该轮 source.patch SHA256 为 `c6e406fa80f64e2e44de903308725f4a0eae1dc9ffafae635a0ec4271d86b6bd`，仍仅涉及既有四包及其文档范围。ContextMeter 接受可选原生比例，token 数和容量可同时未知；ActivityPill 说明 Harness 调 CLI 的统计口径；外部用量新增中性的 `reported` 输入口径，不推断缓存。未提供外部元数据的普通会话沿用原生行为。新候选输出在 `artifacts/dsh-host-extension-021rc2-regressions`，完成预览后才按空闲门禁更新已链接产物，实际安装状态见 `doc/tasks.md`。

## Qoder 积分及未公开 Token（2026-10-18）

该轮 source.patch SHA256 为 `f7457fd6a115a49331aace0045ef03ec24dc2574f5bb004c09a418a964b04c51`。原生用量投影增加可选 `externalCredits`，积分可独立于 token 桶显示；没有公开 token 时，入口及详情标明“Token 未公开”。零积分保留为有效数值，普通原生会话继续使用原有路径。

隔离构建位于 `artifacts/dsh-host-extension-021rc2-qoder-metering`，四包 220 文件校验通过，仓库 runtime-host 冻结 203 文件。完成 `build:preview` 后，Windows 正式 Desktop 在无活动任务时通过官方 CLI 安装同版本候选；真实历史入口及两个弹层实际点验，显示积分 0.252595、上下文 15.7% 和未公开 token。已加入原生渲染用例，但本轮没有执行该扩展源码的独立 Vitest 文件；Windows 插件关联回归及实际桌面证据见 `doc/tasks.md`。未在 Mac 执行测试，未新增模型调用。

后续按用户要求改为纯积分文案：当前 source.patch SHA256 为 `c4be999c2ad18ba2e7d6a49a311295344e904022eeebf6727c1e56444564b89c`，候选 `artifacts/dsh-host-extension-021rc2-credits-hermes`。可用性来源的可选 `usageUnit: credits` 使缺失积分仍使用“积分用量”，有效积分入口只显示积分，弹层也不并列 Token；其他来源沿原路径。四包220文件校验及runtime-host203文件冻结通过，更新原生组件回归源码；本轮该独立 Vitest 文件仍未执行，以 Windows 关联投影回归及正式 Desktop 点验记录对应证据。

## CLI 子会话图片入口（2026-10-18）

原生 rc.2 的 InputBar 已接受 continuable 子会话图片，但隐藏文件输入仍统一 disabled。新增显式、默认关闭的 `childImageUploads`，从 SidebarChat 到共享 ConversationContent 传递；仅 CLI Worker 的实际附件能力为真时开启。`composerPresentation` 继续只控制呈现，不用于授予能力；子会话非图片回执的拒绝保持。120 项 InputBar 与18项 Sidebar 回归、四包类型检查和220文件隔离构建通过。顺带修正原有积分可选参数的显式 undefined 类型声明，无统计行为变更。最终 Windows 实际证据见 doc/tasks.md。
