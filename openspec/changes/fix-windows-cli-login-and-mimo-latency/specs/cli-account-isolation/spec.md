# Spec Delta

## ADDED Requirements

### Requirement: 元数据优化不复活账号
能力元数据缓存 SHALL 不保存或复活可执行认证；每次授权与任务边界 MUST 从当前原生自身来源重读账号和配置，换号、退出、撤销以及路由变化立即使旧绑定不可用。

#### Scenario: 缓存命中但账号退出
- **WHEN** MiMo 能力缓存仍有效而当前自身账号已删除或更换
- **THEN** 拒绝旧任务或要求重新选择，不从能力缓存恢复凭据，不跳过绑定与权限重检

#### Scenario: 并发取消与失败
- **WHEN** 重复查询中某一调用取消或能力查询失败
- **THEN** 取消自身等待和受管资源，失败不发布半成品目录，不影响其他请求的账号核对

### Requirement: Antigravity Windows 原生账号来源
Windows 上 Antigravity 账号核对 SHALL 使用交互式用户会话中原生 Credential Manager 的固定凭据目标，且只向插件返回状态、稳定主体摘要和安全账号标签。凭据正文 MUST 不进入 Gateway、日志或持久化缓存。

#### Scenario: 浏览器授权与终端兑换均已完成
- **WHEN** 用户在 Windows 原生终端完成 OAuth 兑换，账号保存在 Credential Manager 而无明文令牌文件
- **THEN** Desktop 能识别同一账号并绑定目录与任务；SSH 会话无法访问凭据时报告来源不可用，不误报桌面账号退出

#### Scenario: 原生凭据不可读或格式未知
- **WHEN** 原生账号存储不可访问、格式未知或当前主体已改变
- **THEN** 返回安全诊断并拒绝旧绑定，不输出凭据，不从其他账号来源补齐
