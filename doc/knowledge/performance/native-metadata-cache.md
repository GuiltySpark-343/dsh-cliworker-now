# 原生能力元数据缓存与实时权益分开

稳定的原生能力可以短期复用，账号当前是否可用及远端模型权益仍需按原流程核验。这样减少重复帮助命令或能力扫描，同时保留正确的执行来源。

`NativeCapabilityCache` 默认保留三十秒、最多十六个条目，只接受调用者已经验证过的公开能力，返回克隆。`nativeMetadataKey()` 将实际启动计划、可执行文件及脚本身份、物理项目、环境和相关来源快照组合后取摘要；不能确认文件时返回空键，转为不缓存的正常发现路径。TTL 同时处理超时和时钟回拨，不能把时间异常解释为永久有效。

不同 CLI 只复用能证明稳定的部分：Claude 可复用是否支持相关帮助能力，仍读取当前原生认证；Kimi 仅缓存已识别的受管 OAuth 能力结构，当前凭据重新读取；MiMo 的缓存保存能力与凭据摘要，命中时从当前自有配置恢复凭据，退出登录后不能用旧值复活账号。携带凭据的 URL 或无法证明来源的条目不缓存。

这不是统一“缓存所有账号信息”。原始凭据、环境及原生配置不留在缓存条目或键字符串中；摘要也不应作为日志里的账号身份或授权凭证。远端权益发现不因本地能力命中而跳过。

实现：[能力缓存](../../../src/host/native-capability-cache.ts)、[元数据键与 MiMo 缓存](../../../src/host/mimo-metadata-cache.ts)、[调用位置](../../../src/host/first-party-models.ts)；回归：[原生能力](../../../tests/first-party-capability-cache.test.ts)、[MiMo 缓存](../../../tests/mimo-metadata-cache.test.ts)。

关联：[同一查询内复用 Qoder 快照](qoder-query-snapshot.md)、[来源失效](cache-invalidation.md)。
