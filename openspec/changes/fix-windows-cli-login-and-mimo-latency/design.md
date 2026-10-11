# Design

## Context

参见 proposal.md 与上一轮真实 Windows Desktop 私有白名单证据。当前官方 Pi/OpenCode cmd 形态超出 native-launch 白名单；账号外层 Modal 卸载不等待清理；MiMo readFirstPartyModelSources 的 paths/config/models 命令在绑定与目录多次执行，每组三个进程实测约 6 秒。Claude/Kimi OAuth 状态和目录读取分离，不能假设 API 模型列表适用于订阅。

## Goals / Non-Goals

**Goals:** 修复实际入口与生命周期，保留清理失败恢复入口；以真实原生能力补齐登录和目录；降低可测插件前置耗时。

**Non-Goals:** 不修改 Harness 或 SDK，不开启任意 shell、不绕过额度/身份保护、不更换用户模型、不承诺供应商响应速度。缺失 CLI 不作为兼容缺陷强行安装，OAuth 必须用户完成必要授权。

## Decisions

1. 入口使用精确固定 shim 与安装包 bin/身份校验；Pi wrapper静态解析真实安装。拒绝用 cmd /c 兼容未知脚本。Pi1.1.0只有离线SDK/RPC及原生菜单证据支持后纳入。
2. 所有主动关闭交给同一个可等待终端控制器；清理失败保留组件与accountId。Host终止包装仅在Windows补可核验自身范围的回收/退出确认，避免按名称杀进程。原生错误通过短分类或安全白名单呈现，不回传原始环境/异常。
3. ZCode按当前help区分登录与管理能力，明确所用服务商。OMP依据实装18.8.7原生入口/PTY证据修复，不沿用不匹配版本假设。
4. Claude/Kimi账号绑定、模型目录和执行上下文同源；优先原生非生成控制协议/只读账号元数据，不凭公共模型或硬编码别名开放。具体原生能力在实现前通过本机安装代码/帮助确认；不支持则安全短错误并留真实复验待办。
5. MiMo新增有界短时内存缓存，仅含非秘密能力与摘要；键覆盖项目/环境/原生入口身份/自身配置与账号内容摘要。每次重新读取当前凭据并重做远端模型范围检查，不缓存授权、不持久化秘密。默认30秒与16项上限，可根据基线调整但不延长账号信任窗口。
6. 私有验收脚本记录元数据进程数、准备耗时、首输出与完成时间；比较同Windows同模型任务，不以模型服务波动当插件优化收益。
7. 按用户追加要求，Claude 使用可达的自身本地代理，代理关闭时走原生 CLI login。Windows 2.1.296 已证实会话级 --settings 可用空认证字段和官方端点临时屏蔽代理，原设置哈希不变；当前官方账号尚未登录。账号、目录、绑定和 Worker 采用同一来源，界面明确来源，执行中不重试或切换。代理401/403不作为离线；只在新操作前选择来源，记录账号/路由变化。
8. Kimi 2.1.1 的 managed:kimi-code OAuth 使用原生 file 存储、官方固定 coding/v1/models 与 usages 元数据，目录与原生 alias 交集。近过期、401、无可证实剩余额度不得放行；插件不自行调用 token refresh，允许用户在原生终端完成续期或重新授权。
9. 账号终端采用高对比块状光标、就绪后聚焦及明确焦点提示，保持原生终端键盘/粘贴语义，增强授权码输入位置可见性。
10. Windows 实际派遣暴露的名称误判在 routing 内修复：区分插件/工具入口名称与外部 CLI，支持“只使用”分句和同一 CLI 的括号别名。仅全部解析为同一规范 CLI 的重复指令合并；未知项和不同目标仍拒绝。Harness rc.2 的 pre-step 输入来自本步 inbox.claim，并非全历史，不改宿主或截取最后一条消息，以免丢弃同批的真实冲突请求。工具说明中的后续“参数 cli”不得被误当成 CLI 名称后缀。

## Risks / Trade-offs

- 原生版本变化 → 精确能力探针与未知版本拒绝，保留错误边界。
- PID复用/无归属的后代 → 结合创建身份/受管范围，无法确认则保留失败，不盲杀。
- 缓存陈旧 → 内容/入口身份/环境变更失效，授权仍实时；缓存错误结果禁止。
- OAuth需用户操作/额度不可用 → 继续独立修复，实际验收保持待确认，不虚勾。

## Migration Plan

先单元与Windows实际定向测试、typecheck、preview打包；记录包哈希。在Desktop无活动worker/账号终端时备份当前插件安装信息，用原生安装更新正式包，保持账号和会话不变。复验发现回归则恢复原包，保留证据；不推送或发布远端。

## Native Windows account evidence

Antigravity 1.3.3 将 Windows OAuth 保存在交互式用户的 Credential Manager 固定目标 `gemini:antigravity`。固定 PowerShell helper 只投影账号状态、稳定主体哈希和安全标签，原生凭据内容不离开该进程；目录及执行边界重读同一来源。SSH 服务会话无法访问该登录存储不代表 Desktop 未登录，验收使用实际交互式 Desktop。

## Windows 终端与识别补充（2026-10-11）

- 移除共享账号终端的粗黑 focus outline，保留块状光标、自动聚焦和轻量主题化状态；不修改各 CLI 自己画出的终端内容。
- 对照 Harness 原生剪贴板能力与 xterm 键盘/paste 事件，统一用户主动触发的粘贴路径，经 xterm 原生 paste/括号粘贴语义和现有有界输入队列送到 Gateway；防止重复发送、退出后发送以及字符变形。不得后台读取剪贴板或将内容写入日志/持久化。
- 实際 Windows 用受控无秘密字符串测试 Ctrl+V、选择复制与右键粘贴，区分键盘逐字输入与系统剪贴板。原剪贴板内容只在本机临时内存保留以恢复，不导出。
- Codex/Hermes 分开检查 Desktop 实际 PATH、官方默认安装及已核验启动器/包身份；已有有效安装未入旧 PATH 应可发现。未知或缺失入口给准确短原因，不自动安装 CLI、WSL 或将不同平台账号混为一体。
- ZCode 按实际本机版本和错误阶段修复已证实的启动/环境/协议问题；保持原生账号来源和服务商。原生菜单出现只是入口验证，真实授权或登录请求错误需独立复现；缺少授权保留边界。

## 共享终端与 ZCode 登录链接（2026-10-11）

- 按用户要求，两平台共用 React、xterm.js、FitAddon、主题和 Gateway 输入/清理路径；不维护 Windows 专属界面或剪贴板实现。仅原生进程托管、可执行入口发现及已证实的原生浏览器缺陷保留平台适配。
- 实际 Windows ZCode 0.16.9 的终端原始授权链接包含 client_id、redirect_uri、state、response_type，但原生 cmd /c start 打开的 Tabbit 网页只收到 client_id。使用 help 声明的 --no-browser 避开该 Windows opener，保留原生 init/poll/凭据写入流程。Mac 保留原生 opener。
- 共享终端仅在 ZCode login 的固定 Open this URL to sign in: 提示后，识别完整、有限长度的 https://chat.z.ai/api/oauth/authorize 原生 URL；在当前登录流程自动一次打开，并允许用户点击终端中原生网址重新打开；共用 Harness 跨平台 external handler，不改写参数，不启用任意终端链接；URL 仅当前终端内存使用，结束/关闭/重试清空。未知域名或协议保留原生文本，不创建可点击入口。

- 按用户最新要求不设置独立粘贴/打开网页按钮，也不显示底部快捷键小字。选择复制沿用 xterm 原生 copy；右键有选区复制、无选区粘贴。无选区 Ctrl+C 保留原生中断语义。
- Windows Hermes 原生默认账号根为 LocalAppData/hermes，配置和 HERMES_HOME 优先；Mac 保留 ~/.hermes。用户明确授权补全官方 Windows 原生安装，安装与插件代码验证分别记录。

## Hermes Windows 隔离目录依赖绑定补正

- 官方 distlib 启动器记录源 checkout。Windows 与 Mac 共用按 checkout 的原生 install key 定位 committed facts 的规则，Windows 仅补静态 distlib/cmd 读取和 Scripts/python.exe 路径差异；不按修改时间寻找虚拟环境。
- 两平台共用 hermes-native-entry.py，在原生安装锁内再次核验当前环境并取得原生 generation lease，finally 释放。Windows 使用官方 pm.filesystem.lock_fd，Mac 保留 fcntl；不调用 bootstrap/installer，不导入安装 home 的账号配置，保留既有隔离 dotenv 边界。
- auth --help 退出成功只证明依赖入口恢复；实际 Desktop PTY 中出现可交互提供商菜单并可关闭，才记为账号终端启动验收。管道下 model 退出不冒充 PTY 成功。


## Windows 模型目录与设置启动（2026-10-11）

- Pi/OMP 目录准备遵循已有 Windows 原生身份检查，避免对目录使用 POSIX-only open/chmod 组合；两 CLI 继续分别从自身 SDK/RPC 获得模型与思考强度，不补硬编码目录。Codex 读取原生能力及当前账号来源，缺失、超时、未授权分别保留证据。
- 首次打开设置优先所选 CLI，账号状态请求（包含当前项）最多两个并发，其余排队；切换只调整待排顺序，不抢占正在执行的请求。模型目录查询独立进行，这不是所有子进程的数量上限。关闭或禁用取消不再需要的读取，Host 独立负责底层清理；客户端 RPC 取消不作为进程已退出的证明。失败/未安装不作长期缓存，临时查询失败不得伪装成已确认缺少安装。
- 仅在已核验依赖边界内复用无秘密能力元数据，缓存键覆盖实际入口身份、项目、当前账号来源摘要、配置与环境变化；账号、凭据有效性、远端权限/额度仍逐次核验，不缓存远端鉴权结论或取消结果。MiMo、Kimi managed OAuth 能力与 Claude 已支持参数标记的内存缓存各自为 30 秒、最多 16 项。
- 账号状态请求按相同 CLI/规范项目路径合并在途工作，与能力缓存的失效键分开；Host 不缓存已完成的鉴权结果。设置页保留本次打开期间的显示结果直到刷新，不将该显示快照作为任务授权。最后订阅者取消后，Host 等待实际子进程回收或保留清理失败状态；同 CLI/项目的新读等待旧操作清理，不依赖客户端 RPC 的取消返回确认退出。
- 扩展 CLI 模型查询仅返回模型值；成功且捕获的进程范围确认退出后，删除该次独有的 `catalog/<cli>/query-*` 目录及其中原生解压缓存。失败、取消或进程清理未确认时保留现场，不删除原生账号、共享续期目录或其他查询目录，避免 Windows OMP 每次成功刷新累积约 121 MB。
- OpenCode 的登录继续使用共享嵌入式终端，查询进程采用隐藏窗口的 Windows 原生启动；修复应覆盖插件自有 launcher，保持 argv、stdio、ConPTY 和受管进程范围。先记录控制台窗口 PID 与父链确认来源，不屏蔽正常授权浏览器。
- 验收记录实际 Windows 返回模型/effort、首次检测状态、窗口出现情况及冷/热耗时；性能结论只描述实测插件前置变化，不承诺模型服务响应速度。不新增模型调用。
