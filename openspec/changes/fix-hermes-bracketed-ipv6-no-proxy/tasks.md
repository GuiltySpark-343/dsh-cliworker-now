## 1. 实现

- [x] 1.1 `hermesNoProxyEnvironment`：改写带括号/端口/CIDR 的 IPv6 旁路为裸地址并去重；`hermesAccountEnvironment` 合入，覆盖账号终端、续期与任务运行。

## 2. 自动检查

- [x] 2.1 `tests/hermes-no-proxy.test.ts`：实测值改写、大小写两种变量、IPv4/域名不变、无需改写与通配符不覆盖、合入账号环境。
- [x] 2.2 Hermes/账号/绑定相关 44 个测试文件通过（957 通过、1 跳过）；`build:preview` 通过。
- [x] 2.3 Hermes 自带 Python：`[::1]` 复现 `Invalid port: ':1]'`，裸 `::1` 正常；DSH 代理变量下 Nous 凭据解析成功。

## 3. 真实验收

- [ ] 3.1 Desktop 重启后：Hermes 状态不再显示“暂时无法续期”，账号终端选择 Nous Portal 不再报 `Invalid port`。
