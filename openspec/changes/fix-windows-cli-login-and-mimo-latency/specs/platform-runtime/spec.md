# Spec Delta

## ADDED Requirements

### Requirement: Windows 官方固定入口兼容
Windows 官方 npm 原生 exe shim 与 Pi 管理式 Node 启动器 SHALL 可经静态安装身份核验解析到实际原生入口。版本支持 MUST 建立在安装包契约和实际离线探针上，未知脚本或不可信路径继续拒绝。

#### Scenario: 官方入口
- **WHEN** 官方固定启动器指向核验通过的包与原生程序
- **THEN** 插件识别已安装并以独立 argv 启动，不经任意 batch 执行

#### Scenario: 入口异常
- **WHEN** 启动器含附加命令、版本指针越界、包身份不符或目标无效
- **THEN** 拒绝并提供入口不可用的短原因，不冒充未下载 CLI 或自动执行脚本
