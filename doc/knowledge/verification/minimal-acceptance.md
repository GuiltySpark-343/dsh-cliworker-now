# 日常验收按变更影响范围选择

修复时先验证被修改的行为及相邻风险；正式交付前再按授权执行全量检查。测试数量不能代替覆盖范围。

## 选择方法

| 变更范围 | 最小验收重点 |
| --- | --- |
| 纯说明文档 | 核对当前源码、链接、索引覆盖及实现与历史的区分 |
| 协议解析、字段映射 | 对应解析测试；分片、缺失字段、重复事件与错误输入 |
| 模型、账号、缓存 | 账号／项目隔离、来源失效、失败与迟到响应、明确选择后才改偏好 |
| 设置与会话交互 | 相关组件回归；离页、全部关闭方式、快速重开和保存失败 |
| 进程及 Windows 启动 | 启动、取消、进程归属、退出后的清理及目标平台检查 |
| 原生会话或安装资源 | 身份绑定、历史恢复、资源清单、隔离构建及对应环境验收 |

TypeScript、Gateway 协议或包结构变化时补对应类型检查与隔离构建；改变可见交互时按影响做实际界面核对。不要为了纯文档整理启动模型或更新 Desktop。

## 执行入口

在仓库根执行以下示例；测试文件应替换为本次实际关联文件：

```sh
pnpm --config.verify-deps-before-run=false exec vitest run tests/settings-display-cache.test.ts tests/settings-dialog.test.tsx
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false build:preview
```

这些是可选检查入口，不是每次改动都要依次执行的固定清单。无关的重复全量测试不会补齐目标平台或真实模型证据。

## 源码与验证入口

- [项目规则](../../../AGENTS.md)与[OpenSpec 配置](../../../openspec/config.yaml)：检查范围和授权边界。
- [package.json](../../../package.json)：当前命令、锁定工具版本。
- [设置回归](../../../tests/settings-dialog.test.tsx)、[展示缓存回归](../../../tests/settings-display-cache.test.ts)：交互与竞态的示例。
- [实际验证记录](../../tasks.md)：记录真正执行的命令、结果和未执行项。

## 关联笔记

- [验证证据分层](evidence-levels.md)
- [隔离构建与 Desktop 更新](isolated-build-and-desktop.md)

[返回分类索引](README.md)
