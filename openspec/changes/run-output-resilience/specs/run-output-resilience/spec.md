## ADDED Requirements

### Requirement: 单轮输出超限不得终止 CLI 轮次
宿主 SHALL 区分“过程镜像预算”与“轮次成败”。默认 `overflow: truncate` 时，镜像超出预算 MUST NOT 终止 CLI 进程或把轮次判为失败；插件 SHALL 停止转发后续非结果帧、继续读取 CLI 输出与解析协议，并保留最终结果。MUST 在结果帧上标记 `truncated`，在 Worker 记录上标记 `displayTruncated`，并在面板显示“过程已截断”。配置为 `overflow: fail` 时 MAY 保留原有的“超限即终止”行为。

#### Scenario: 长轮次超出镜像预算
- **WHEN** 一轮的时间线或原始流累计超过 `maxRunBytes`
- **THEN** CLI 继续运行并正常返回最终结果，轮次状态由结果决定，面板标记过程已截断

#### Scenario: 单帧过大
- **WHEN** 单个桥接帧超过 `maxLineBytes`
- **THEN** 截断模式丢弃该帧并继续，严格模式按原行为终止

#### Scenario: 下一轮清除标记
- **WHEN** 被截断的 Worker 开始新一轮
- **THEN** 上一轮的 `displayTruncated` 被清除，不会误标新一轮

### Requirement: 原始运行日志按项目保存并可只读查看
插件 SHALL 把事件时间线与原生原始流写入 `<project>/.dsh/cliworker-now/logs/`，并自动创建 `<project>/.dsh/.gitignore`（内容 `*`）。项目不可写时 MUST 回退到全局状态目录并记录一次警告。元数据、角色库、绑定、预设与备份 MUST 继续保存在全局状态目录。插件 SHALL 提供只读查询返回某轮原始日志的尾部（默认 256 KiB，上限 1 MiB），MUST NOT 返回整份文件。

#### Scenario: 项目日志落盘
- **WHEN** 某 Worker 在项目 A 中运行
- **THEN** 它的 `events.jsonl` 与 `raw.jsonl` 位于项目 A 的 `.dsh/cliworker-now/logs/`，不写入项目其他位置

#### Scenario: 旧日志兼容
- **WHEN** 升级后首次追加某 Worker 的时间线，而旧文件仍在全局目录
- **THEN** 旧文件被迁入项目目录（跨盘用复制后删除），序号保持连续；原始流读取回退到全局路径

#### Scenario: 查看原始日志
- **WHEN** 用户在面板选择“查看原始日志”
- **THEN** 对话框只显示该轮文件的尾部与总字节数，并明确说明是否截断

### Requirement: 原始日志保留策略
插件 SHALL 限制原始日志占用：每个 Worker 保留最近若干轮（默认 20），全局保留上限（默认 512 MiB），超出时删除最旧的文件。运行中的轮次 MUST NOT 被删除；保留清理 MUST 有频率上限，避免每轮全量扫描。

#### Scenario: 单 Worker 超出轮次上限
- **WHEN** 某 Worker 的原始日志超过保留轮数
- **THEN** 最旧的若干轮被删除，当前轮保留

#### Scenario: 全局超限
- **WHEN** 所有原始日志合计超过全局上限
- **THEN** 按修改时间从旧到新删除，直到回到上限以内

### Requirement: 工具失败不判定整轮失败
工具条目的失败（非零退出、工具结果标记失败、权限被拒绝）SHALL 作为诊断记录，MUST NOT 单独把整轮判为 failed。只有轮次级信号（回合终态非完成、进程非零退出、协议违约、回合结束时仍有未完成工具）MUST 导致失败。诊断文案 SHALL 区分权限/审批拒绝、非零退出与一般执行失败。

#### Scenario: 检查脚本返回非零
- **WHEN** Agent 运行一个退出码非零的检查脚本，但随后给出完整最终回复
- **THEN** 轮次状态为 completed，诊断里记录该工具失败

#### Scenario: 真正的轮次失败
- **WHEN** CLI 报告回合失败、进程非零退出或协议违约
- **THEN** 轮次仍为 failed，不受本规则影响

### Requirement: 进度事件降量
插件 SHALL 合并高频进度事件并对单个载荷截尾（默认 32 KiB），MUST NOT 在每个增量里重复发送累计全文或同一内容的重复副本。原始流 MUST 保留完整内容，供原始日志查看。

#### Scenario: 大命令输出
- **WHEN** 一个工具命令产生 1 MB 输出
- **THEN** 时间线只保留合并后的尾部片段，事件总量不再随增量平方增长
