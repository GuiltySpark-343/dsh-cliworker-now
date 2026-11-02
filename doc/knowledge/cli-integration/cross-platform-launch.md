# 跨平台启动入口归一化

找到文件后还要确认实际运行时和参数边界；不能把 Windows 包装脚本直接交给 shell 解释。

## 1、机制与实施要点

Host 通过参数数组启动任务。`native-launch.mjs` 把已核实入口归一化为原生程序或固定 Node/Bun 入口，解析 npm shim 时读取文件与 `package.json` 的 `bin` 声明，核对包名、目标和目录边界，不执行包装文本。

JavaScript 入口要求可读的普通文件，不要求类 Unix 的可执行位；Node 路径可使用 Host 的 `process.execPath`，Electron 子进程配合 `ELECTRON_RUN_AS_NODE`。Bun 入口另行查找所需运行时，不能把 Bun 程序强行交给 Node。

Windows 还存在 Desktop 内置原生 CLI、Python 安装与受管子进程窗口行为等差异。Codex 的后台启动、Hermes 的安装解释和隐藏进程各有专用处理，新 CLI 要验证自己的进程范围与运行时依赖。

增加独立 runner、启动器或辅助脚本时，还要核对构建中的运行资源清单与复制入口。源码可直接导入的文件，打包后也必须位于桥预期的位置；Client 图标资源同样要随包交付。

## 2、易错边界

文件名正确不代表安装身份正确；npm shim 可以指向 IDE、其他包或异常目标。带空格路径应作为单个 argv 值保留。后台无窗口不等于进程已回收；这些能力必须分别验证。

## 3、源码与验证入口

- [入口归一化](../../../src/host/native-launch.mjs)、[原生进程启动](../../../src/host/native-spawn.mjs)。
- [构建与运行资源复制](../../../scripts/build.mjs)。
- [Windows 后台进程](../../../src/host/windows-hidden-process.ts)、[Hermes Windows 安装适配](../../../src/host/hermes-windows-installation.ts)。
- [启动器回归](../../../tests/native-launch.test.ts)、[原生启动回归](../../../tests/native-spawn.test.ts)、[Windows 隐藏进程回归](../../../tests/windows-hidden-process.test.ts)。

## 4、关联笔记

[地址发现](executable-discovery.md) · [权限与清理](permissions-and-cleanup.md)

[源码与安装包契约](../verification/source-package-contract.md)
