## ADDED Requirements

### Requirement: 执行次数
插件 SHALL 为每个 Worker 记录并展示已开始的轮次数量（执行次数）。每次开始新一轮时 MUST 累加并持久化，MUST NOT 把准备、排队或重试失败计为额外执行；旧记录缺少该字段时按 0 处理，不要求迁移。执行次数只用于展示与状态判断，MUST NOT 影响停止、删除、恢复或权限语义。

#### Scenario: 多次续聊
- **WHEN** 同一 Worker 首次派遣后又被续聊两次
- **THEN** 面板显示执行 3 次，且三次运行各自保留独立的运行记录

#### Scenario: 旧记录
- **WHEN** 读取升级前创建、没有执行次数字段的 Worker
- **THEN** 按 0 次展示并可继续续聊，续聊后从 1 开始递增
