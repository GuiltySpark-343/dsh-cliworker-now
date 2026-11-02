# 权限映射与进程清理

接入 CLI 时必须同时实现原生权限与完整生命周期；收到取消回执后仍要确认受管进程范围退出。

## 1、机制与实施要点

权限由当前 CLI 的原生规划/只读、允许编辑模式映射到插件选项，并受所属 Harness 主会话权限约束。不能把宿主的 full-access/auto 任意映射成某个 CLI 的未知开关。当前 Hermes、Qoder 没有插件可用的原生规划选项，不能展示为已支持。

运行时还维护同会话互斥和同目录写任务串行。每轮桥有私有请求与控制目录，先尝试原生 cancel/interrupt/abort/stop，再由 Host 终止和核对进程范围；清理未确认时保留阻塞，避免下一轮重叠写入。

HTTP 服务仅监听回环地址，使用每轮认证；临时认证和需要恢复的 session 数据分开清理。所有注册、订阅、文件句柄和子进程都要覆盖正常、错误、取消、超时及 Host 退出路径。

## 2、易错边界

未知审批请求不能默认允许；不支持的规划模式应拒绝启动。进程退出与原生会话删除不同，清理桥不能误删恢复历史。插件沿用原生和宿主保护，不额外制造操作系统沙箱承诺。

## 3、源码与验证入口

- [权限选项](../../../src/shared/worker-permissions.ts)。
- [Worker 运行时](../../../src/host/runtime.ts)、[进程管理](../../../src/host/process.ts)。
- [桥准备和清理](../../../src/host/native-worker.ts)。
- [停止回归](../../../tests/native-stop.test.ts)、[原生运行时回归](../../../tests/native-runtime.test.ts)、[Windows 进程回归](../../../tests/windows-process.test.ts)。

## 4、关联笔记

[通信协议](native-transports.md) · [跨平台启动](cross-platform-launch.md) · [最小验收](integration-acceptance.md)
