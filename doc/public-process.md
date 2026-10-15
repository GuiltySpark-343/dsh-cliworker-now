# CLI 公开过程展示

本页记录 v0.7.9 在 2026-10-15 核对的公开输出范围。过程区展示 CLI 已经返回的可读内容，不请求、推断或解密未公开的内部推理。公开思考也不代表完整内部推理；模型可能不返回该字段。

## 已接入范围

| CLI | 接收的原生公开字段 | 展示规则 |
| --- | --- | --- |
| Codex | `item.completed`，`item.type=reasoning` 的字符串 `item.text` | 标为“Codex 思考摘要”；按 item ID 更新，和最终回复分开。 |
| Claude Code | `assistant.message.content[]` 中 `type=thinking` 的字符串 `thinking` | 标为“Claude Code 公开思考”；按 message ID 和 block index 去重。 |
| Pi / OMP | RPC `message_update.assistantMessageEvent` 的 `thinking_delta.delta`、`thinking_end.content`；`message_end.message.content[]` 中的 `thinking` | 标为对应 CLI 的“公开思考”；按消息和 contentIndex 聚合，结束快照覆盖增量，最终消息可撤回被标记为 redacted 或不再存在的块。 |
| Grok Build | `streaming-json` 的 `thought.data`、`plan.entries[].content/status` | 思考按原生 `usage` 响应边界聚合；计划在过程区显示最新快照。 |

工具记录沿用各适配器已支持的原生事件。Codex 的 `todo_list` 仍按既有工具记录展示。以上能力不增加模型调用、不更改模型思考强度、不启动额外进程。

Antigravity、Kimi、MiMo Code、ZCode、Hermes Agent、OpenCode 本次没有新增思考字段；保持现有回复、工具和状态记录。没有可展示的摘要时显示“本轮 CLI 未返回可展示的思考摘要；以下为已有工作记录。”这表示当前接入的事件没有可读内容，不推断原生应用永远没有该能力。

## 协议依据

- [Codex 官方 JSONL 转换源码](https://github.com/openai/codex/blob/e89b7c442c0433ad5167e72a5a25bb6d0712766a/codex-rs/exec/src/event_processor_with_jsonl_output.rs)：`map_item_with_id` 只将 `ThreadItem::Reasoning.summary` 拼接后映射为 `ReasoningItem.text`，不从 raw content 读取。该版本的开始事件不输出 reasoning，完成时才输出。
- [Claude 官方 thinking 文档](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)：官方示例从返回的 thinking block 读取 `block.thinking`；签名、加密和 redacted 内容不是可读摘要。插件不增加 display 参数或修改 Claude 的原生请求配置。
- [Pi 官方 JSON/RPC 事件文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)及[消息类型](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/message-types.md)：本次同时核对本机官方包 `@earendil-works/pi-coding-agent` 1.1.0 的同名文档。文档明确 delta、end 和最终 message 的覆盖关系；原生 `assistant-message.js` 将可见 thinking 作为独立区块展示。
- [OMP 官方 RPC 文档](https://github.com/can1357/oh-my-pi/blob/c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4/docs/rpc.md)及[原生思考展示](https://github.com/can1357/oh-my-pi/blob/c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4/packages/tui/src/chat/assistant-message.ts)：RPC 公开 thinking delta/end 和 contentIndex，最终 message 保留完整公开块；原生 TUI 单独显示 `type=thinking`，不渲染 redactedThinking。
- Grok Build：本次核对已安装 CLI 生成的官方 `docs/user-guide/14-headless-mode.md` 的 `streaming-json` 章节，以及 `05-configuration.md` 的 `show_thinking_blocks` 配置。前者列出 `thought.data` 和计划条目，后者说明原生界面显示思考块。该本机文档作为原生安装证据，个人目录和原始运行数据不随仓库分发。

## 数据与界面边界

公开思考使用独立 `reasoning` 事件：`text` 是来源标签，`detail` 是当前可读文本快照。重复 step 覆盖快照，空快照清除旧内容；不拼接重复完整文本，也不更新最终答复或成功状态。Pi、OMP、Grok 的实时快照最多每 200 毫秒输出一次，完成或进程结束时立即保留最后观测内容。停止后保留原生状态，并显示本轮已中断或结束，不把未完成的思考块伪装为已完成。

白名单不读取 `signature`、`thinkingSignature`、`encrypted_content`、`raw_content`、`redacted_thinking`、`redactedThinking` 或 redacted 块中的文本。没有公开字段的事件不通过对象序列化变成“思考”。计划只投影可见条目，不复制扩展元数据。

界面沿用现有主题和可折叠过程行，公开文本用 React 文本节点展示，不解释为 HTML。工具详情和公开思考均只在过程区出现，最终答复保持独立。

## 本轮验收边界

使用明确标注的合成协议事件和模拟 Pi/OMP RPC 进程验证公开字段白名单、快照覆盖、流式合并、最终正文隔离、私密字段排除、持久化重读与组件渲染。首次 Pi/OMP 回归受执行沙箱的本机回环监听限制而未完成，使用获准的本机合成服务器环境重跑通过。

真实账号、真实模型输出、Windows、安装后的 Desktop 及全量验收不由上述合成测试替代；实际组件浏览器检查与本轮集成验收统一记录在 `doc/tasks.md`。
