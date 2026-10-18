# DSH 0.2.1-rc.1 可选原生会话扩展

此目录移植此前已授权的完整原生侧栏呈现及会话统计来源接口，不扩大宿主权限或替换用户配置。旧 `dsh-0.2.0-rc.2` 保留。

官方公开 tag `dsh-v0.2.1-rc.1` 的源码 commit 为 `1600d8a1e140dcde43a1a0941940a0480712c011`。实际 Desktop 的 build stamp 为 `ed75efeffee65f9fe93625bbd76a68cb219aaaf9`，该对象不在公开仓库，不能声称两个 SHA 相同；实际安装四个 client.js 已与官方同版本 npm 对照：ui-session 字节一致，其余只差构建根路径导出的 CSS namespace 和 source region 路径，规范化后代码及样式一致。

只修改 ui-session、ui-conversation、ui-subagent、ui-chat 及相应 slot 文档。`provideProjections` 仍按真实 SessionReference/绑定代际接受独立 observable 并清理订阅；普通会话没有来源时走原路径。外部每轮账单、unknown/estimated、上下文分类/来源、运行中状态及已证明历史最终回复顺序沿原合同保留，不生成缺失公开过程。

适配保留新版 `conversation.chat.flow` 及 keyed rows/group actions，外部 process proof 在该 flow 内投影；保留新版分别注册的 ActivityPill/UsagePill 和原生 dialog 生命周期，只添加可选外部来源/未知显示。不恢复旧 ChatNodeList，不把旧 StatsPills 布局覆盖新版。新的 group-tree 位置判定代替旧独立节点 kinds 常量，保持新版节点的原生分组语义。

## 隔离构建

依赖仅位于 `.cache/dsh-host-build-deps-021rc1`，内容地址store独立位于 `.cache/dsh-host-pnpm-store-021rc1`。`build-dependencies` 为冻结输入。`dependency-links.json` 逐个记录依赖身份/hash；允许读取根既有依赖，但不会修改它们。下载均为官方发布包，安装时禁用 lifecycle scripts。

```sh
# 官方源码固定到上述 release tag；不要以安装版本 buildStamp 冒充公开 Git commit。
git clone --branch dsh-v0.2.1-rc.1 --single-branch https://github.com/deepseek-ai/deepseek-harness.git .cache/dsh-host-source-021rc1
git -C .cache/dsh-host-source-021rc1 apply ../../host-extensions/dsh-0.2.1-rc.1/source.patch
node scripts/build-host-extension.mjs --target 0.2.1-rc.1 --prepare-links
node host-extensions/dsh-0.2.1-rc.1/check-client-types.mjs
node scripts/build-host-extension.mjs --target 0.2.1-rc.1
node scripts/build-host-extension.mjs --target 0.2.1-rc.1 --verify
```

准备依赖需将三个build-dependencies文件复制到新隔离目录，再使用已有pnpm执行带独立store-dir的 `install --ignore-scripts`。禁止在根仓库或用户profile执行该安装。四包 artifact 继承官方同版本 Host入口及声明，仅重编 client；新增可选接口的类型由源码检查，未冒称继承声明包含扩展接口。当前候选需由root核对manifest、隔离preview和最终Desktop验收，再协调安装窗口；本构建命令不安装或重启。
