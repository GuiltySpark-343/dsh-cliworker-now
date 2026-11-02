# 新 CLI 最小验收

新 CLI 验收按证据层级推进，分别记录离线逻辑、真实初始化、Desktop 界面与真实模型任务，避免用某一层替代其他层。

## 1、机制与实施要点

| 层级 | 最小检查内容 | 能证明的范围 |
| --- | --- | --- |
| 离线回归 | 分帧、迟到/重放、缺字段、错误、权限拒绝、恢复、取消和清理 | 指定夹具下的协议与状态逻辑 |
| 真实元数据 | 安装身份、握手、账号来源、目录和精确配置回执 | 当前安装版相关原生接口可用 |
| 隔离包与 Desktop | `build:preview`、目标平台安装/加载、控件与真实数据归属 | 该候选和该环境的集成表现 |
| 已授权真实任务 | 模型/强度、工具产物、同会话续聊、运行中停止 | 已执行场景的真实链路 |

日常只运行影响范围对应的最小关联检查；先用隔离包验收，再在没有活动任务时更新 Desktop 链接。真实任务使用用户已授权且明确保存的选型，不猜模型、不为查目录额外生成。

## 2、易错边界

模拟测试须标注模拟；初始化握手不是模型验收；模型回复“完成”不是产物证据；Windows 与 macOS 结果不能互相代替。失败、订阅限制、未执行平台及缺失指标都应保留，不能为了归档把任务虚勾完成。

## 3、源码与验证入口

- [原生验收脚本](../../../scripts/smoke-native.ts)：先查看 `--help`。
- [关联测试示例](../../../tests/native-qoder.test.ts)、[跨平台地址测试](../../../tests/windows-cli-resolution.test.ts)。
- [项目规则](../../../AGENTS.md)、[OpenSpec 流程](../../openspec.md)、[实际验证记录](../../tasks.md)。

本笔记列出验收方法，不声明本轮重新运行了这些测试或所有 CLI 已通过全部平台验收。

## 4、关联笔记

[接入总核对表](README.md) · [原生数据接口](native-data-interfaces.md) · [权限与清理](permissions-and-cleanup.md)

完整方法另见 [证据层级](../verification/evidence-levels.md)、[隔离构建与 Desktop](../verification/isolated-build-and-desktop.md)、[跨平台证据](../verification/cross-platform-evidence.md)。
