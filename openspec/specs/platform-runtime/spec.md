# platform-runtime Specification

## Purpose

规定插件在 macOS 与 Windows 中如何识别并启动已安装的原生 CLI、使用其自身保护与权限模式、解析对应系统路径并确认进程清理，确保跨平台声明来自实际运行证据。

## Requirements

### Requirement: CLI 原生保护方式
插件 SHALL 使用各 CLI 实际支持的原生权限和计划模式，不额外套插件操作系统进程沙箱。宿主授权、项目及模型选择边界 MUST 保持；原生不支持的只读模式不得通过普通写入模式冒充。

#### Scenario: 原生任务启动
- **WHEN** 用户授权并选择已安装 CLI、模型和强度后启动任务
- **THEN** 只传该 CLI 实际支持的原生参数，不依赖 macOS sandbox-exec，不静默换用 CLI 或权限模式

#### Scenario: 只读能力缺失
- **WHEN** 请求原生 CLI 不支持的只读任务模式
- **THEN** 保留明确拒绝，不添加不存在的开关或绕过宿主限制

### Requirement: Windows 原生入口与路径
插件 SHALL 在 Windows 按实际官方安装入口启动 exe、Node/Bun 和 Python CLI，参数保持独立 argv，不拼接 shell。盘符与 UNC、当前原生账号目录和安装资产 MUST 按该平台解析；未知 batch 形态短错误拒绝。

#### Scenario: npm Windows shim
- **WHEN** 官方固定 npm shim 指向可核验的自身 JavaScript 入口
- **THEN** 使用该入口记录的 Node/Bun 运行时启动，CLI 参数按原数组保留，包含空格/中文/引号的参数不触发 shell 执行

#### Scenario: 不受支持的入口
- **WHEN** 自定义 batch 包含无法确认的程序或逻辑
- **THEN** 拒绝并显示短原因，不以 cmd /c 执行任意 batch

#### Scenario: 当前认证路径
- **WHEN** 当前原生登录位于 Windows 盘符或 UNC 路径
- **THEN** 状态和执行读取相同 CLI 的当前来源，不生成错误盘符路径或复制旧认证

### Requirement: 跨平台进程范围清理
Windows 任务 SHALL 使用可确认后代归属的 Host 进程管理能力；停止、取消与清理失败语义保持一致。测试 MUST 验证实际 Windows 进程范围，不能只用 mock 证明后代退出。

#### Scenario: Windows 任务取消
- **WHEN** 用户停止或取消启动了后代的任务
- **THEN** 等待所有受管理进程退出再报告停止成功；无法确认时阻止冲突任务

#### Scenario: 关闭账号终端
- **WHEN** 用户关闭原生账号菜单
- **THEN** 清理属于该菜单的进程和临时状态，持久账号和其他终端保留

### Requirement: Windows 桌面 CLI 自定义安装发现
Host SHALL 从 Windows 已知默认目录、当前用户及公共安装登记、已运行产品的映像位置和已知快捷方式位置定位 ZCode/OpenCode 桌面随附 CLI，支持自定义磁盘、中文及空格目录。只检查对应产品实际 CLI 布局，MUST 不以桌面 GUI 或安装痕迹代替 CLI，不执行登记或快捷方式中的命令。无安装记录、PATH 或快捷方式且程序未运行的任意解压目录 SHALL 保留显式路径配置方式。

#### Scenario: ZCode 自定义目录
- **WHEN** 用户安装 ZCode 到默认目录外，登记或快捷方式指向该安装且存在配套 CLI/provider
- **THEN** 自动解析该 CLI，状态、模型、登录和任务使用相同入口，无需用户追加 PATH 或手改执行路径

#### Scenario: 安装位置字段为空
- **WHEN** 卸载登记的 InstallLocation 为空，但匹配产品的 DisplayIcon 或快捷方式指向实际安装
- **THEN** 从有效文件路径定位安装根，兼容卸载 ICO、带图标索引的 EXE 和带引号路径，不执行该字段

#### Scenario: OpenCode 随附 CLI
- **WHEN** OpenCode 实际发行物含 resources/opencode-cli.exe 或安装根的独立 CLI
- **THEN** 选取核验通过的独立 CLI，不能执行 OpenCode 桌面主程序冒充 CLI

#### Scenario: 无可发现信息
- **WHEN** 任意位置的便携文件夹没有登记、已知快捷方式或 PATH，且程序未运行
- **THEN** 不扫描任意驱动器猜测，返回未找到 CLI 的明确原因及对应显式路径字段

### Requirement: Windows 入口优先级与歧义
显式 CLI 路径及已部署的 ZCode 完整运行时 SHALL 保持优先，正常的原生 PATH/shim 行为 SHALL 保留。自动发现 MUST 去重同一真实入口，并拒绝多个不同可用安装；损坏的显式来源不得静默换成另一安装，PATH 指向已识别桌面 GUI 时只能转到该安装的核验 CLI 或报告 CLI 缺失。

#### Scenario: 显式来源优先
- **WHEN** 用户配置有效路径，或存在已部署的 ZCode 完整 CLI
- **THEN** 不读取其他桌面安装覆盖该来源；显式错误保持可见

#### Scenario: 登记与快捷方式重复
- **WHEN** 同一入口通过 32/64 位登记和多处快捷方式出现
- **THEN** 归一化并按真实文件去重，不制造重复安装或随机选择

#### Scenario: 多个不同安装
- **WHEN** metadata 确认多个不同可用 ZCode 或 OpenCode CLI
- **THEN** 返回需显式选择路径的短提示，不按目录顺序、版本或修改时间猜测

### Requirement: 桌面安装查询边界和清理
桌面安装发现 SHALL 是有数量、目录深度、输出及超时上限的只读查询，仅处理相应产品记录和已有快捷方式。查询 MUST 支持取消及确认进程范围退出，错误不暴露个人路径、原始登记或凭据；自动 metadata 中的相对、device 或远程网络路径不得被采用。非 Windows 平台及其他 CLI SHALL 不启动该查询。

#### Scenario: 查询被取消或超时
- **WHEN** 状态、选型或启动准备取消了安装查询
- **THEN** 等待查询进程退出，不使用迟到入口、不启动 CLI；范围清理未确认继续阻塞

#### Scenario: 异常或越界 metadata
- **WHEN** 查询不完整、格式无效、输出过大或候选路径不合法
- **THEN** 返回简短探测错误，不执行 metadata 或泄露其原文，不把异常伪装成确定未安装

#### Scenario: 其他平台
- **WHEN** macOS 或其他 CLI 解析原生入口
- **THEN** 保留既有行为，不查询 Windows 注册表或快捷方式

#### Scenario: 不依赖桌面图标或快捷方式
- **WHEN** 用户未创建或已经删除桌面及开始菜单快捷方式
- **THEN** 已知默认目录或有效 InstallLocation / DisplayIcon / App Paths 仍可独立定位 CLI；DisplayIcon 仅作为安装登记路径，不要求桌面存在图标

#### Scenario: 无登记但程序已运行
- **WHEN** 自定义目录未登记且缺少快捷方式，但相应产品程序正在运行
- **THEN** 可读取精确产品名的程序映像位置作为线索并核验相同安装中的 CLI，不读取命令参数、不启动程序、不把同名进程本身视为 CLI

### Requirement: Electron 宿主中的物理安装识别
Windows CLI 安装识别 SHALL 依据磁盘中的实际文件类型、权限和内容，不因宿主将 ASAR 视作虚拟目录而拒绝有效 CLI。可选桌面归档标记缺失 MUST 不阻止普通独立 CLI；真实读取失败、损坏入口及显式桌面 GUI 仍须按既有边界报错。检查不得改变宿主全局归档行为。

#### Scenario: npm CLI 无桌面归档
- **WHEN** Electron 宿主发现有效 OpenCode npm 原生 CLI，旁侧不存在桌面 app.asar
- **THEN** 保留该 CLI 并自动记录路径，不因可选标记缺失报桌面入口不可用

#### Scenario: 桌面归档为物理文件
- **WHEN** PATH 命中 OpenCode 桌面 GUI，磁盘存在桌面归档与核验通过的独立 CLI
- **THEN** 自动解析该安装的独立 CLI；手动指定 GUI 时仍明确拒绝

#### Scenario: 真实文件错误
- **WHEN** 安装文件无读取权限、不是普通文件或 PE 内容损坏
- **THEN** 保留安装错误，不将其当作可选归档缺失，不静默换用其他 CLI

### Requirement: Windows 后台查询不创建独立终端窗口
插件 SHALL 在已核验的 Windows CLI 安装与版本上后台完成设置首次加载、账号及模型刷新、模型或思考强度保存时的 CLI 查询，不创建可见的独立终端窗口。已核验安装启动器的内部派生不得绕过该保证；隐藏处理 MUST 保留原账号、模型目录、参数、环境、输出及失败语义，不省略校验或切换安装。未核验的第三方启动器版本保留原调用并明确验证边界，不猜测其内部协议或声明已通过窗口验收。用户显式打开的内嵌账号终端及登录浏览器保留原行为。

#### Scenario: 冷启动首次打开设置
- **WHEN** Desktop 冷启动后首次打开设置，并查询启用 CLI 的账号与当前 CLI 目录
- **THEN** 查询与结果正常完成，无属于该后台查询的可见控制台或 Windows Terminal 窗口

#### Scenario: 模型及强度自动保存和刷新
- **WHEN** 用户选择模型、思考强度，或手动刷新账号／目录
- **THEN** 保留真实账号绑定与目录校验，后台启动不弹独立终端，失败仍在插件内反馈

#### Scenario: 安装启动器内部调用原生程序
- **WHEN** 已确认的官方 Node 启动器会通过继承标准句柄再次派生原生 CLI
- **THEN** 使用同一安装的核验原生启动信息和原生环境语义，保持字节输出与进程范围管理，不能静默调用其他安装

#### Scenario: 取消或启动失败
- **WHEN** 后台查询取消、超时或原生入口不可用
- **THEN** 等待受管理进程范围清理，保留取消和失败状态，不降级为可见终端或未验证入口

#### Scenario: Antigravity 后台自动更新
- **WHEN** Windows 插件后台读取 Antigravity 模型或启动 Antigravity 任务
- **THEN** 仅本次子进程设置官方 `AGY_CLI_DISABLE_AUTO_UPDATE=true`，避免内部更新进程弹出独立终端；账号、模型和任务参数保持原行为，不修改系统环境、用户更新标记或显式账号终端

#### Scenario: 其他平台和显式账号交互
- **WHEN** 在 macOS 执行相同查询，或用户主动打开内嵌账号终端
- **THEN** 维持现有平台及交互行为，不为隐藏后台窗口而更改原生保护、认证或终端输入输出
