# Proposal

## Why

实际 Windows Desktop 0.7.6 验收暴露账号终端关闭后残留、ZCode/OMP 终端失败、Pi/OpenCode 官方启动入口误报未安装，以及已登录账号模型目录不可用的问题。MiMo 一组无模型元数据命令约 6 秒，重复检查造成显著启动等待，需要在保持账号隔离的前提下修复并实际复验。

## What Changes

- 安全识别 Windows 官方固定 npm 原生入口和 Pi 管理式启动器；核验 Pi 1.1.0 原生契约后支持当前安装，不放开任意 batch。
- 统一账号终端关闭的等待、失败与重试；修复 Windows 自有终端进程清理，提供不含凭据的启动/退出诊断。
- 按安装版本真实支持的登录能力处理 ZCode/OMP；修复可证实的 OAuth 账号状态、身份绑定与模型发现不一致，并保留必须用户授权或原生不支持的明确边界。
- MiMo 仅缓存不含凭据的短期原生能力元数据，消除同一次操作的重复启动；实时重读自身账号和配置，账号授权与撤销检查不缓存。
- 修复实际验收发现的明确派遣误判：插件名称与工具参数不当作 CLI 名称，同一 CLI 的括号别名与重复指令归一；不同或未知目标仍拒绝猜测。
- 在实际 Windows 中比较优化前后元数据与任务耗时；先隔离构建回归，再无活动任务时更新 Desktop 并复验登录、启动、续聊及停止。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `platform-runtime`：官方 Windows 入口识别、版本身份和原生终端范围清理。
- `cli-connection-health`：账号终端可靠关闭、短错误和恢复入口。
- `cli-model-discovery`：能力元数据复用与当前 OAuth 模型目录的证据一致性。
- `cli-account-isolation`：优化后继续按当前自身账号/配置核验，不由缓存恢复认证。
- `worker-dispatch`：明确目标的同名别名归一及插件工具说明排除，保留多目标和未知目标边界。

## Impact

涉及 native-launch、Pi installation、账号 Host/Client 生命周期、first-party models/account binding、MiMo metadata、相关测试、README 和设计/实际记录。保持 Harness 核心、SDK、用户技能及既有会话/账号不变。用户已授权修复与此前的最小模型选型；不自动购买额度、不伪造原生模型能力、不承诺供应商响应延迟，缺少安装/授权的 CLI 保留实证边界。
