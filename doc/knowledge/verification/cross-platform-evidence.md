# 跨平台兼容需要对应平台的证据

macOS 与 Windows 可以共用同一套业务状态机；可执行发现、启动器、权限和进程清理仍需分别验证。

## 机制

项目把共享业务与平台适配分开：缓存、模型选择和 Gateway 行为共用实现；Windows 原生安装发现、隐藏控制台及进程范围通过专门入口处理。原生来源文件另有 Windows ACL 可信性校验；插件存储的 POSIX mode 设置不能替代 Windows 权限实测。跨平台问题应先判断属于业务状态还是系统接口，避免为相同业务复制两套缓存和保存逻辑。

Windows 自动验证有两个现成入口：CI 在 Windows 原生 runner 构建并运行指定测试；远程测试工具把受限源码快照及构建包传到专用目录，核对哈希，使用 Windows 本机依赖执行既定检查并回传结果。两者都需要检查本次报告，不能套用历史数字。

## 边界

远程测试入口默认不调用模型，也不自动验收 Desktop 控件。包在 Windows 成功加载，不能代替点叉、点击外侧、Esc 关闭或模型选择的界面验收。macOS 静态审查加 Windows 实机通过，也不能写成“双平台 Desktop 已验收”。

比较性能时须说明统计口径：顶层查询并发数、CLI 启动次数、Desktop 后代进程数和原生 HTTP／RPC 请求数分别统计，任何一个为零都不代表其他项为零。

连接信息、密钥路径、原生账号文件和运行日志保存在忽略的私有目录；远程只写工具确认归属的专用根目录，不覆盖真实账号或项目。

## 源码与验证入口

- [Windows 远程测试指南](../../windows-remote-testing.md)与[远程脚本](../../../scripts/windows-remote.mjs)：输入范围、哈希和报告协议。
- [Windows CI](../../../.github/workflows/windows.yml)：当前实际执行的测试范围。
- [远程流程回归](../../../tests/windows-remote.test.ts)、[Windows 进程回归](../../../tests/windows-process.test.ts)。
- [原生来源权限检查](../../../src/host/native-file-privacy.mjs)及[Windows ACL 回归](../../../tests/native-file-privacy-windows.test.ts)：来源可信性校验，不能等同于存储目录 ACL 设置。

## 关联笔记

- [验证证据分层](evidence-levels.md)
- [隔离构建与 Desktop 更新](isolated-build-and-desktop.md)

[返回分类索引](README.md)
