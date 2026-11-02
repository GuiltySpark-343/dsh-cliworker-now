# 注册 CLI 与能力声明

接入新 CLI 要让共享身份、Host 校验、设置入口和执行能力保持一致；加入下拉菜单只完成了展示层。

## 1、机制与实施要点

- 共享层以 `CLI_IDS` 定义可执行的活跃 CLI，`CLI_LABELS` 定义用户名称，`CLI_SHORT_NAMES` 定义自动 Worker 名称。`CliId` 还保留退役 `harness`，仅为读取历史。
- Host 的配置 schema、可执行路径配置、账号查询和目录发现均按 CLI 分派。新增身份后，要逐一核对对应入口，避免设置能选、Host 却拒绝或落入默认分支。
- 执行能力分别落在 transport、权限选项、运行中消息模式与原生会话 capabilities；不能用一个“支持该 CLI”开关代替。运行中引导还须结合实际当前通道确认。
- Client 继续通过 Harness Gateway 调用 Host；进程、账号材料和持久化留在 Host。

## 2、易错边界

`EFFORTS` 是共享词汇全集，不表示所有 CLI 都支持全部强度。历史兼容 ID 也不能重新出现在可执行列表。新增完整产品行为应按项目 OpenSpec 流程管理；文档补充本身不增加能力。

## 3、源码与验证入口

- [共享类型与 CLI 身份](../../../src/shared/types.ts)：`CLI_IDS`、`HarnessConversationFeature`。
- [Host 配置与 Gateway 方法](../../../src/host/index.ts)。
- [权限选项](../../../src/shared/worker-permissions.ts)、[运行中消息能力](../../../src/shared/running-message.ts)。
- [Qoder 接入回归入口](../../../tests/qoder-integration.test.ts)。

## 4、关联笔记

[通信协议](native-transports.md) · [原生会话](native-conversation-integration.md) · [最小验收](integration-acceptance.md)
