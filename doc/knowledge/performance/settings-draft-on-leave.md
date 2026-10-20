# 设置页先编辑草稿，离开或关闭再保存

模型或思考强度选择立即更新页面中的完整组合；把需要账号、目录核验的保存移到离页之后，可避免每次选择都等待 Gateway 和原生查询。

`CliSettings` 的显式选择事件调用 `SettingsPreferenceSaves.stage()`，只记录本地草稿及其写入函数，不立即调用 `configure()`。模型变化同时保留仍受支持的强度，否则采用该模型声明的可选强度；不会将两个互不一致的字段分开写入。目录初始加载、没有编辑的导航和刷新仅更新展示，不自动保存猜测默认值。

当前 CLI 页面卸载时，effect 清理先取消组件订阅，再统一 `flush(cli)`。切到其他 CLI、智能体设置，或关闭整个设置窗口都会走这一路径。因此叉号、点击窗口外侧、Esc 与外部状态使窗口关闭均触发提交，不为每个关闭按钮各写一套保存逻辑。导航和窗口先完成变化，保存继续在后台运行。

关闭设置只取消未完成展示查询，不取消已经提交的偏好写入。Host 最终保存仍做原生账号及选型核验；失败保留草稿和错误，不能将“已切页”当作“已保存”。关闭整个应用或进程崩溃不等于正常卸载完成，这套内存草稿并不提供崩溃恢复保证。

实现：[设置页选择与卸载](../../../src/client/settings-dialog.tsx)、[草稿协调器](../../../src/client/settings-preference-saves.ts)；回归：[设置页测试](../../../tests/settings-dialog.test.tsx)；规格：[默认模型保存契约](../../../openspec/specs/worker-management/spec.md)。

关联：[写入串行与重试](preference-write-order.md)、[对话选型的不同语义](conversation-selection.md)。
