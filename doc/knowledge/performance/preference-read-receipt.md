# 读取开始代次防止旧快照覆盖新保存

后台保存与重新打开设置会并行发生。即使写入按顺序执行，较早发出的读取仍可能较晚返回，显示一个已经过期的默认值。

典型顺序是：打开窗口发出设置读取；此前关闭触发的保存随后成功；旧读取最后到达。如果只按响应到达顺序覆盖状态，界面会从刚保存的 High 倒退到旧 Low，用户容易误判保存失败。

当前实现用 `preferenceReadVersion()` 在发出 `cliSettings()` **之前**捕获全局回执代次。每次成功保存递增 `receiptVersion`，并记录该 CLI 槽的 `savedVersion`。同步返回快照时，只有读取起点已包含该保存，才清除本地已保存回执；若保存发生在读取开始之后，继续用更新的回执显示选择。这比较的是因果顺序，而非服务器时间戳或响应到达时间。

保护不能变成永久锁定本地值。保存成功后新发起的读取带上新的代次，应接受 Host 当前项目默认值，包括其他窗口的后续变更；未完成或失败的显式编辑仍保留。代次仅是 renderer 中的显示协调信息，不证明 Host 写盘成功，也不替代账号授权。

实现：[回执代次与 sync](../../../src/client/settings-preference-saves.ts)、[读取起点](../../../src/client/settings-dialog.tsx)、[默认值合并](../../../src/client/settings-display-cache.ts)；回归：[迟到读取与后续新快照](../../../tests/settings-dialog.test.tsx)。

关联：[写入串行](preference-write-order.md)、[来源代际](cache-invalidation.md)。
