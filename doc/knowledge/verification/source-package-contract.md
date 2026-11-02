# 构建包要同时核对依赖与原生资源

同一份源码只有使用匹配的 SDK、协议声明和随包资源，才能形成可追溯的安装包。

## 机制

`selectBuildDependencies` 以当前 `package.json` 锁定的 DSH 目标选择依赖图，检查相关官方包版本。仓库依赖不匹配时可以使用已准备的隔离依赖目录；显式指定错误版本会失败，避免构建时悄悄回退。Host 与 Client 分别生成类型及打包配置，Client 的 Typert 导入也必须来自同一选定依赖图。

完整原生对话使用随包 `runtime-host` 资源。`verifyHostRuntime` 核对清单、文件大小、SHA256、包声明和随包 `source.patch` 哈希，拒绝越界路径、符号链接和清单外资源。仅在启用 `sourcePatch` 且仓库对应补丁存在时，额外比较仓库与随包补丁；preview 不复制 `host-extensions`，激活守卫也不执行这项仓库比较。只读激活守卫继续检查宿主有效加载条目，防止同一原生模块重复、被外部来源覆盖或原配置丢失；冲突时停止加载并给出原因。

## 边界

校验和只能证明资源与清单一致，不能证明业务正确。资源安装采用受控扩展包与补丁契约，不能解释成允许直接修改用户的宿主安装或配置。原生扩展源码、补丁和冻结资源变更后需成套更新与验收，不能只复制一个生成文件。

具体 SDK 目标以当前包声明为准；宿主运行兼容范围、构建目标和历史文档标题是不同信息。

## 源码与验证入口

- [build-dependencies.mjs](../../../scripts/build-dependencies.mjs)：`selectBuildDependencies`、`buildTypeConfig`。
- [host-runtime.mjs](../../../scripts/host-runtime.mjs)：`verifyHostRuntime`。
- [host-extension-guard.mjs](../../../scripts/host-extension-guard.mjs)：`inspectHostRuntimeEntries`。
- [构建依赖回归](../../../tests/build-dependencies.test.ts)、[原生资源回归](../../../tests/host-runtime-package.test.ts)、[Client 协议导入回归](../../../tests/build-client-remote-info.test.ts)。

## 关联笔记

- [隔离构建与 Desktop 更新](isolated-build-and-desktop.md)
- [规格、原理与历史记录分工](specs-and-history.md)

[返回分类索引](README.md)
