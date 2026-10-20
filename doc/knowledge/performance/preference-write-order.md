# 偏好后台写入必须串行并保留失败草稿

将保存移到后台之后，需要独立于弹窗组件管理写入顺序，否则快速切页和重开可能让旧保存覆盖新选择。

`SettingsPreferenceSaves` 为每个 CLI 保留一个槽，区分最新草稿 `draft`、已经离页提交的 `waiting` 与执行中的 `active`。`flush()` 提交当时的完整快照；同一槽同时最多执行一个写入，等待期间新的离页快照替换尚未执行的旧快照。前一个写入完成后只继续已经提交的 `waiting`，不能因为还有新草稿，就把用户仍在编辑的选择提前写入。

保存回执只在仍属当前来源时生效。旧写入完成可以更新它自己的保存结果，但不能清空较新的草稿。失败保留完整选择与错误，下一次离开或关闭再重试；不靠自动无限重试掩盖账号问题。新来源的失效会增加代际、清除旧草稿并取消旧写入，旧回执不能再发布成功。

排序状态属于共享展示池而不是某次 React 渲染。即使项目展示目录因八项目上限被淘汰，池也单独保留未完成写入，避免同项目重开后创建第二个写入者。写入收尾后，池在后续 `resolve()` 时移除已结束的 `pendingWrites` 保留项。

实现：[保存协调器](../../../src/client/settings-preference-saves.ts)、[池的 pendingWrites](../../../src/client/settings-display-cache.ts)；回归：[设置页竞态](../../../tests/settings-dialog.test.tsx)、[展示淘汰与写入顺序](../../../tests/settings-display-cache.test.ts)。

关联：[离页保存](settings-draft-on-leave.md)、[保存回执与迟到读取](preference-read-receipt.md)。
