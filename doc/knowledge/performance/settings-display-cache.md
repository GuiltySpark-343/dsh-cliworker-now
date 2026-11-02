# 设置页缓存完成结果以复用首次预热

关闭设置窗口后保留已经完成的账号摘要和模型目录，重开时先显示同来源结果，只补未完成部分。这解决的是 Client 组件卸载后状态丢失，区别于 Host 已经存在的磁盘目录缓存。

`SettingsDisplayPool` 按 Gateway API 对象隔离，再按 Host 代际和项目分组。每个 `SettingsDisplayCache` 存账号摘要、目录及其完成错误；不保存 `loading` 中间态，不保存凭据，不启动定时器或写本地磁盘。读取和写入均克隆，避免菜单组件修改共享结果。池保留最近使用的八个展示项目，超限淘汰最久未用项目。

每次打开仍先调用轻量 `cliSettings()`，获得当前开关、默认偏好和来源元数据，再决定能否复用。成功预热后跨设置窗口复用，不代表应用重启也保留 Client 状态；Host 换代后重新发现。已完成错误同样保留到主动刷新，防止每次打开都自动重复失败的昂贵查询。

只有 Host 没有提供缓存能力时才走旧查询路径；收到格式错误的元数据则显示错误，不能把损坏信息当作“不支持缓存”。展示项目被淘汰时仍需保留未完成保存的排序状态，避免新实例越过旧写入。

实现：[展示缓存](../../../src/client/settings-display-cache.ts)、[设置窗口](../../../src/client/settings-dialog.tsx)；回归：[展示缓存测试](../../../tests/settings-display-cache.test.ts)、[设置页测试](../../../tests/settings-dialog.test.tsx)。

关联：[来源代际与局部失效](cache-invalidation.md)、[偏好写入串行](preference-write-order.md)。
