# 账号来源与执行身份绑定

账号显示、模型目录和实际任务必须绑定同一 CLI 自身来源；缓存登录状态不能代替执行授权。

## 1、机制与实施要点

账号模块按 CLI 读取实际登录或 API 来源，提供登录、退出和管理动作。需要交互时使用该 CLI 的原生账号终端；平台差异由 Host 处理，Client 不持有凭据。

`cli-account-binding.ts` 汇总账号来源、稳定主体和路由等材料形成绑定。OAuth 的 access/refresh 文本可能正常轮换，因此稳定主体与 token 字节分开；未签名声明只作为身份标签，不证明账号权益。

目录缓存要附来源绑定；执行前重新确认当前来源、模型路由和选择。账号、可执行路径或相关配置变更时，使旧展示/目录失效，不能拿另一账号的可选模型继续执行。Qoder 还专门核对临时元数据查询与实际环境来源，避免展示账号与任务账号偏离。

## 2、易错边界

检测到配置文件不等于已登录；邮箱相同也不必然代表提供方和组织一致。目录查询本身可能触发 CLI 原生行为，不能未经核实宣传为绝对无写入。私有材料不能进入仓库、消息正文或公开测试产物。

## 3、源码与验证入口

- [账号入口与原生终端动作](../../../src/host/accounts.ts)。
- [来源身份绑定](../../../src/host/cli-account-binding.ts)。
- [Qoder 来源与临时查询](../../../src/host/qoder-accounts.ts)。
- [账号绑定回归](../../../tests/cli-account-binding.test.ts)、[运行账号隔离回归](../../../tests/runtime-account-isolation.test.ts)。

## 4、关联笔记

[原生数据接口](native-data-interfaces.md) · [模型与强度](model-effort-selection.md) · [地址发现](executable-discovery.md)
