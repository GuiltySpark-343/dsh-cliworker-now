## Why

用户 2026-10-26 在 macOS 实测 Antigravity 账号终端（`agy` 1.4.7）后提出：

- 退出登录要手动在终端输入 `/logout`，希望点击「退出登录」后由插件直接完成退出。
- 登录时需要先在菜单里选 Google OAuth，再到浏览器授权，把页面上的授权码粘贴回终端并按回车；终端里没有足够提示，别人不知道怎么做。粘贴完成后没有明显反馈，也没有提示要按回车；登录成功后终端里也没有明确的成功提示（用户是“乱按了一下回车”才确认成功的）。

本机探测（退出状态，只读，浏览器被替身拦截）：启动 `agy` 显示 `You are currently not signed in.` 与 `Select login method:` 菜单（`1. Google OAuth` / `2. Use a Google Cloud project`）；选择 Google OAuth 后显示 `Your browser should open automatically.`、授权链接，以及 `If you aren't automatically redirected, paste the authorization code below:` 和输入框 `authorization code...`。agy 没有退出登录子命令，只能在主界面输入 `/logout`。

## What Changes

- Antigravity「退出登录」：插件打开原生终端，确认 agy 主界面已就绪（已登录）后，由 Host 一次性写入 `/logout` 与回车；随后以钥匙串/原生账号状态确认已退出，显示「已退出 Antigravity」并自动关闭终端。启动即显示未登录时不输入任何内容，提示无需退出并关闭。未在限定时间内确认退出时停止自动操作，提示查看终端。只对该动作、只写这一条命令，不向任何 CLI 写入其他内容。
- Antigravity「登录」：Host 依据终端输出识别登录步骤，在终端上方显示分步引导：
  1. 选择登录方式：用 ↑/↓ 选「Google OAuth」后按回车；
  2. 在浏览器登录 Google 并授权，复制页面上的授权码，点击终端后粘贴（右键或 ⌘V / Ctrl+V）；
  3. 检测到粘贴后醒目提示「授权码已粘贴，按回车完成登录」；
  4. 按回车后以原生账号状态确认登录，成功时醒目显示「已登录 Antigravity，可以关闭终端」；限定时间内未确认则提示查看终端中的错误后重试。
- 引导文字全部由 Host 固定生成，不转发或渲染 CLI 输出内容；授权码不记录、不回显到引导、不离开终端输入通路。

## Capabilities

### Modified Capabilities

- `cli-connection-health`：新增「Antigravity 账号终端引导与自动退出」。

## Impact

- Host：`src/host/accounts.ts`（会话引导状态、自动退出写入、身份轮询）；新增 `src/host/agy-account-guide.ts`（输出标记识别，纯函数）。
- 共享协议：`AccountFrame` 新增可选 `guide`（旧 Client 忽略）。
- Client：`src/client/account-terminal.tsx` 显示引导横幅；样式按 `doc/settings-ui-design.md`；多语言词条。
- 原约束「账号终端不发送 prompt/斜杠命令」改为：仅 Antigravity 退出动作在确认主界面就绪后发送 `/logout`（用户 2026-10-26 明确要求）。
