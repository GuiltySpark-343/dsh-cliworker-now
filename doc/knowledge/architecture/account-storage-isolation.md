# 账号归属与私有存储分层保护

结论：缓存按 CLI 自身账号与路由绑定，运行数据保存在插件私有目录；展示缓存不能成为跨账号执行授权。

## 机制

`readCliAccountBinding` 只读取对应 CLI 已核验的原生来源，将源位置、路由和身份材料规范化后生成绑定摘要。缺失或无法确认的来源明确失败，不拿另一个 CLI 的登录或环境凭据填补。目录缓存、Worker 与实际发送分别核对归属；有效模型 ID 也不代表当前账号仍可使用。

`WorkerStorage` 用独占 `host.lock` 防止两个 Host 同时恢复同一私有存储。`atomicJSON` 先以排他方式写临时文件，再 rename；目录和文件设置 POSIX `0700/0600`。事件按 Worker 与 run 隔离，配置、账号绑定和原始诊断不进入分发笔记或 Git。

## 易错边界

摘要不代表敏感来源可以公开；账号原文、令牌、私有日志和运行记录仍留本机。POSIX mode 是当前代码的权限设置意图，不等于已经证明 Windows ACL 完全一致；Windows 需要单独检查实际文件权限。CLI 原生查询可能有自身缓存或 OAuth 续期副作用，不能笼统称为纯只读。

## 源码与验证入口

- [账号绑定](../../../src/host/cli-account-binding.ts)：`readCliAccountBinding`；[私有存储](../../../src/host/storage.ts)：`atomicJSON`、`WorkerStorage`。
- [绑定回归](../../../tests/cli-account-binding.test.ts) · [运行账号隔离](../../../tests/runtime-account-isolation.test.ts) · [存储回归](../../../tests/storage.test.ts)。
- [实际平台证据边界](../verification/cross-platform-evidence.md)。

关联：[工具桥](authorized-tool-bridge.md) · [模型目录隔离](model-catalog-isolation.md) · [返回分类索引](README.md)
