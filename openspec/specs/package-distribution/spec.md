# package-distribution Specification

## Purpose

让 macOS 和 Windows 用户从默认中文 GitHub 首页或完整英文页面获取准确的安装与能力说明，并用固定版本的一条命令安装完整的预构建插件包，发布资产能够通过远端下载和校验核对。

## Requirements

### Requirement: 双语首页与单行安装
README.md SHALL 默认提供中文首页，完整英文页有双向语言切换。推荐安装代码块 MUST 只含一条可执行命令，无上下注释；命令使用相同跨平台 dsh plugin 语法、明确profile和实际已发布的预构建 npm 包名及 `@latest` 选择器，保留GitHub Release预构建包作为备用来源。

#### Scenario: 打开仓库首页
- **WHEN** 用户打开 GitHub 默认分支首页
- **THEN** 默认显示中文，English 链接打开完整英文介绍，语言切换和图片路径有效

#### Scenario: 跨平台安装
- **WHEN** macOS 或 Windows 用户已配置 Desktop 的 dsh 命令并执行安装行，且安装器当前策略允许 npm latest 版本
- **THEN** 通过包名将执行时的 npm latest 版本安装到指定 profile，无需用户克隆、构建源码或批准插件prepare脚本；web/desktop profile 含义准确

#### Scenario: 主动升级已有安装
- **WHEN** 用户已有旧版插件并再次执行推荐的 `@latest` 安装命令，且安装器当前策略允许 npm latest 版本
- **THEN** 指定 profile 更新至执行时的 npm latest，文档明确只有执行更新命令才更新，不把宿主启动描述成自动更新

#### Scenario: 安装器暂缓刚发布版本
- **WHEN** npm 已公开新版本，但安装器的新版本等待策略仍选择旧版本
- **THEN** 安装说明明确等待规则及核对实际版本的方法，不把命令退出成功视为升级成功；保留已验证的固定预构建来源，不修改用户安装器保护配置，最新版本升级验收保持待办

#### Scenario: Registry未发布
- **WHEN** 对应npm版本尚未发布或发布失败
- **THEN** 不把不存在的短命令宣传为可安装；保留已验证的预构建Release来源及明确待办，不以源码简写冒充预构建安装

### Requirement: 发布证据与能力范围
Release SHALL 包含版本一致的完整预构建包和校验文件，npm和Release远端下载 MUST 与同一公开预构建包哈希一致，并验证独立 profile 的固定 npm 版本安装及通过 `@latest` 从旧版升级。能力说明 SHALL 区分平台运行层验证与第三方 CLI/模型实际调用，不能把 mock、安装成功或目录可读写作生成成功。

#### Scenario: 发布资产验证
- **WHEN** 新版 Release 上传并公开
- **THEN** 查询npm发布记录并下载实际registry及Release文件核对校验，确认 Host/Client/协议/辅助资产完整，不包含凭据或私有日志

#### Scenario: 第三方运行限制
- **WHEN** 某 CLI 在 Windows 没有可用原生安装或未获得调用授权
- **THEN** 保留对应依赖或未验证范围，不因插件可安装就声称该 CLI 和全部模型真实通过

### Requirement: GitHub 源码安装入口
分发文档 SHALL 提供 `github:SuperWheel/dsh-cliworker-now` 的 Desktop 和 Web 原生安装方式、必要构建工具，并说明未固定引用跟随仓库默认分支、固定 commit 对应特定源码。Git 源安装 MUST 在满足构建前置条件且安装器允许该依赖构建后生成完整 Host、Client、协议及辅助资产；未授权或构建失败不得称为安装完成。插件不得自动修改用户构建保护配置或系统工具环境。npm 与 Release 预构建包继续不含构建生命周期脚本，普通源码安装依赖不自动重建当前插件。

#### Scenario: 已允许目标源码构建
- **WHEN** 用户已准备文档要求的构建工具，并按安装器提示允许该确切源码依赖构建
- **THEN** 生成完整可加载产物并按实际包名注册，无需手动克隆和单独运行构建命令

#### Scenario: 尚未允许源码构建
- **WHEN** 安装器拒绝首次 Git 源依赖的构建
- **THEN** 保留原生错误和确切依赖标识，文档说明仅对对应来源授权后重试，不提供全局放开脚本的步骤，不伪报安装成功

#### Scenario: 缺少源码构建工具
- **WHEN** 安装器能下载源码，但构建时不能调用所需包管理器
- **THEN** 保留原生失败，文档指引准备构建工具后重试，不把下载成功称为安装完成，也不自动修改系统 PATH

#### Scenario: 指定源码提交
- **WHEN** 用户在 GitHub 简写后添加完整 commit 引用
- **THEN** 安装与该提交对应的源码产物，不把默认分支或同版本号的其他源码当作同一个安装来源

#### Scenario: 普通依赖安装与预构建分发
- **WHEN** 开发者在现有源码仓库安装依赖，或用户安装 npm/Release 预构建包
- **THEN** 不因为本次新增 Git 源安装钩子自动重建当前 Desktop 链接；已发布 v0.7.8 资产保持不变
