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

### Requirement: Windows Codex 与 Hermes 已有安装识别
插件 SHALL 核验 Windows 上 Codex 与 Hermes 的既有安装路径和实际原生入口，区分未发现、入口不兼容及版本不支持；不得仅因 Desktop 继承的旧 PATH 而误报已知官方路径中的有效安装不存在。启动 MUST 继续使用核验后的参数数组，不执行未知脚本或自动更换运行系统。

#### Scenario: 官方安装未在 Desktop PATH
- **WHEN** 用户已在该系统的已知官方位置安装 CLI，但 Desktop PATH 尚未包含该路径
- **THEN** 核对包/入口身份后识别并使用该安装，或明确报告该平台入口不支持，不要求重复安装

#### Scenario: 安装证据不足
- **WHEN** 已知路径和当前可用入口均无法核验，或仅找到不同系统的入口
- **THEN** 报告可核查的缺失或兼容边界，不伪造已安装、不静默改用其他 CLI/WSL
