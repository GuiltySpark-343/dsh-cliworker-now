# CLI 可执行地址发现

地址发现同时支持自动探测与显式选择，并把路径记录限定到当前机器，避免 Desktop 继承旧 PATH 后持续找不到 CLI。

## 1、机制与实施要点

`resolveCliExecutable` 协调手动路径、部署配置和自动记录，再执行 CLI 专属发现。手动记录优先；无显式部署配置时可复用自动记录。自动文件消失后失效重查，路径 revision 防止旧请求覆盖用户的新选择。

macOS 除 PATH 还识别官方用户安装目录及必要的应用内脚本；Desktop 不会自动加载 `.zshrc`。Windows 覆盖固定用户目录、npm 入口、Codex Appx，以及 ZCode/OpenCode 有界的卸载信息、App Paths、快捷方式等系统元数据。

系统元数据只是位置线索，必须再验证目标是否为对应 CLI。Qoder 特别区分 `qoder` 分发器/IDE 与独立 `qodercli`。新 CLI 应补自身安装来源与明确缺失/损坏错误，不扫描任意磁盘猜版本。

## 2、易错边界

“安装目录存在”“应用可打开”与“CLI 可执行”不同。手动路径应为完整文件路径，不附外层引号、命令或参数。跨机器复制项目配置不能把一台机器的绝对路径当另一台的有效入口。

## 3、源码与验证入口

- [发现总入口](../../../src/host/adapters.ts)：`executableFor`、`resolveCliExecutable`。
- [按机器保存路径](../../../src/host/cli-executable-paths.ts)。
- [Windows 安装线索](../../../src/host/windows-cli-installation.ts)、[Desktop 元数据发现](../../../src/host/windows-desktop-cli-installation.ts)。
- [Windows 路径回归](../../../tests/windows-cli-resolution.test.ts)、[Desktop 安装发现回归](../../../tests/windows-desktop-cli-installation.test.ts)。

## 4、关联笔记

[跨平台启动](cross-platform-launch.md) · [账号绑定](account-binding.md) · [最小验收](integration-acceptance.md)
