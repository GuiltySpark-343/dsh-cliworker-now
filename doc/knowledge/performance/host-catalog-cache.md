# 模型目录持久缓存只提供已验证选项

Host 保存已经核验的模型及思考强度，减少菜单重复发现；保存的目录是展示依据，不能成为永久执行授权。

`SettingsCatalogCache` 以平台、机器、项目和 CLI 的摘要作为键，目录同时记录原账号绑定。`get()` 在本轮 Host 中核对当前绑定后复用已完成结果；首次发现、强制刷新或来源变化时重新查询。`remember()` 校验结构、大小和查询代际，只有仍属当前来源的结果才能进入内存并原子写盘。内容相同不重写文件，避免无意义磁盘写入。读盘检查常规文件、链接、大小及读取前后身份，不能把任意 JSON 当成可信目录。

展示读取 `display()` 不启动 CLI，只在键与原绑定一致且不存在待查或失败状态时返回副本。`displayBinding()` 只承认当前 Host 内存中的核验回执，不从旧磁盘目录恢复“当前账号已确认”的结论。新 Host 的设置页首次发现仍重新识别来源；刷新失败不会偷偷恢复旧列表。

这一缓存适合稳定的模型能力，不适合保存仍有效的登录结论、实时余额或执行许可。项目默认值另存：刷新目录不应为用户猜一个替代偏好，失效默认值需重新选择。

实现：[SettingsCatalogCache](../../../src/host/settings-catalog-cache.ts)；回归：[目录缓存测试](../../../tests/settings-catalog-cache.test.ts)；契约：[模型发现规格](../../../openspec/specs/cli-model-discovery/spec.md)。

关联：[设置完成结果缓存](settings-display-cache.md)、[对话选型与执行前核验](conversation-selection.md)。
