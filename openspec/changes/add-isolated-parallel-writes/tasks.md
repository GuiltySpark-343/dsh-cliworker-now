# Tasks

## 1. 实施

- [x] 1.1 设置：GeneralSettings 新增 `isolatedParallelWrites`（缺省关闭），「CLI Worker 设置 → 任务调度」开关及说明；关闭时调度与此前一致。
- [x] 1.2 副本：私有状态目录 `isolated/<workerId>/`（0700/0600），APFS `COPYFILE_FICLONE`，条目/大小上限，跳过符号链接与排除目录，记录逐文件哈希及文本基线；`assertIsolatedCopy` 专用校验，`projectDirectory()` 保持不变。
- [x] 1.3 调度：仅开关开启且 `drain()` 检测到同目录写冲突时隔离；无冲突仍在主目录；超限或复制失败回落排队并在任务卡显示原因；同会话互斥不变。
- [x] 1.4 运行：Worker 项目身份保持原项目，CLI cwd/原生目录参数改为副本；首轮在副本路径重新核对账号绑定；追问/恢复回到同一副本；隔离运行不接通 DSH 工具桥、拒绝 fork。
- [x] 1.5 合并：自实现 diff3 三方合并（单侧直写、双侧文本 diff3、二进制/类型变化/大小写重命名为冲突，不写冲突标记），有冲突项目零写入并保留副本；成功后清理副本，结果为未提交改动。
- [x] 1.6 丢弃：任务卡确认弹窗及 `cliworker_discard` 用户确认；目录确认删除后才报告成功。
- [x] 1.7 生命周期：复制中停止删除部分副本且不启动 CLI；复制完成后才收到的停止同样删除副本；Host 重启恢复 `preparing`/`merging` 状态，目录缺失提示只能丢弃；`close()` 等待合并/丢弃结束。
- [x] 1.8 Client：任务卡隔离状态行与「合并」「丢弃」按钮、`IsolationDialog`；Host Remote `mergeIsolation`/`discardIsolation` 与主 Agent 工具 `cliworker_merge`/`cliworker_discard`。

## 2. 自动检查

- [x] 2.1 `tests/diff3.test.ts`：单侧、双侧不重叠、重叠/相邻冲突、相同改动、超过编辑距离上限。
- [x] 2.2 `tests/isolated-workspace.test.ts`：复制/上限/排除/符号链接与路径逃逸、合并（单侧、双侧干净与冲突、二进制、新增/删除/重命名、可执行位、类型变化）、取消清理、Windows 分隔符路径判断。
- [x] 2.3 `tests/isolated-runtime.test.ts`：开关关闭不隔离、冲突才隔离、超限回落排队、复制中停止、追问回到同一副本、重启恢复、合并/丢弃后释放。重复运行 10 次均通过。
- [x] 2.4 `tests/isolation-ui.test.tsx`、`tests/settings-dialog.test.tsx`、`tests/general-settings.test.ts`：按钮仅空闲时显示、显式确认后才调用、冲突列表与副本位置、开关保存。
- [x] 2.5 `node scripts/build-preview.mjs`（Host/Client 类型检查与隔离构建）。
- [x] 2.6 `pnpm spec validate add-isolated-parallel-writes --strict`。

## 3. 文档

- [x] 3.1 同步 AGENTS.md、`openspec/config.yaml` 同目录写规则例外，`doc/design.md` 新增章节，README 中英文功能条目，`doc/tasks.md` 验证记录。

## 4. 未执行

- [ ] 4.1 真实 CLI 多任务在副本中运行、追问与合并（未调用真实模型）。
- [ ] 4.2 DSH Desktop 实机查看开关、任务卡与合并/丢弃弹窗（明暗主题、窄屏）。
  - 2026-10-25 Mac 浅色默认窗口：开关、任务卡状态、合并/丢弃弹窗通过；暗色、窄屏未查。
- [ ] 4.3 隔离被绕过：CLI 按提示词写入原项目绝对路径（ZCode Edit 实测成功），主 Agent 未被告知改动待合并而要求在真实目录重做。需修复后复验。
- [ ] 4.3 Windows 实机（仅以平台条件单元测试覆盖路径分隔符；复制回退到普通复制未在 Windows 验证）。
- [ ] 4.4 Linux reflink / 非 APFS 文件系统上的复制性能与回退。

## Workflow follow-up

- 4.x 未完成前保留活动 change，不归档；界面文字仅中文，待 i18n 分支接入 `language` 后统一处理。
