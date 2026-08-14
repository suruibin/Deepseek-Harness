# dsh-desktop-electron

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-harness)（`dsh`）Web GUI 的 Electron 桌面外壳：启动 `dsh web`，等待服务端的就绪行，把 GUI 托管在独立窗口里，并常驻托盘。

兼容性已针对当前可用的最后一个内测 CLI `@deepseek-ai/dsh` `0.0.1-rc.1`（`snapshot-20260811T152241Z-da262ec14c`）完成核验。外壳仅依赖维护中的 `dsh web --host <host> --port <port>` 参数和 `dsh web: <URL>` 就绪行。

> 本仓库是 `dsh-external` 组织下的 DSH 内测社区仓库，**不携带任何 harness 源码** —— 后端用的是你自己安装的 `dsh`。官方不保证公开发布后该组织仍然存在，请自行保留副本。

## 这是什么

Web GUI 是 harness 交互最丰富的界面，但平常只活在浏览器标签页里：没有任务栏存在感、没有托盘，每次启动都要开终端并且让标签页一直挂着。这个外壳把它变成一个真正的桌面窗口。

它**只是一个外壳**：不打包 Node 运行时，也不打包 harness 依赖闭包 —— 跑的是你机器上已有的那个 `dsh web`。因此 harness 升级后它依然正确，不会锁死在某个快照上。

| | |
|---|---|
| **窗口** | 沙箱化渲染进程（`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；preload 仅暴露透明度调节所需的 IPC 桥）—— GUI 就是一个普通 Web 应用 |
| **托盘常驻** | 关闭窗口只是隐藏，服务端继续运行；只有**退出**才终止服务端 |
| **单实例** | 二次启动聚焦已有窗口，而不是再起一个服务端 |
| **不留孤儿进程** | 退出时 tree-kill 服务端；即使主进程被硬杀（任务管理器、崩溃），reaper 子进程也会补上这次清理 |
| **平台** | Windows、macOS、Linux —— 纯 Node/npm 工具链，无需 Rust/Go/Swift |

## 前置要求

一个可用的 `dsh web`，按以下顺序解析：

1. **`DSH_BIN`** —— 显式指定 `dsh` 可执行文件路径；
2. **`DSH_HOME`** —— harness checkout 根目录（用 `install.sh` 安装的话是 `~/.dsh/source/current`）。优先用其构建产物 `apps/cli/lib/bin.js`；没有则走 tsx 源码启动，与该 checkout 自己的 `pnpm run dsh` 完全一致；
3. **`PATH` 上的 `dsh`**。

服务端始终监听 `127.0.0.1`，端口由操作系统分配（`--port 0`），因此永远不会和已有的 `dsh web` 冲突 —— 浏览器实例和这个外壳可以同时开着。

## 从源码运行

```sh
npm install
DSH_HOME=~/.dsh/source/current npm run dev
```

## 打包

```sh
npm run dist        # 安装包输出到 release/
npm run dist:dir    # 只输出未打包目录，用于快速冒烟
```

安装包未签名，因此 Windows SmartScreen 和 macOS Gatekeeper 首次运行时会告警。打包后的应用仍然需要宿主机上有 `dsh` —— 见「前置要求」。

## 行为说明

- **Windows 权限模式**。Windows 没有 harness 的隔离后端，所以 CLI 默认的 `workspace-write` 模式在那里无法启动。当 `DSH_PERMISSION_MODE` 未设置时，外壳回退到 `danger-full-access`（审批提示被禁用）并打印警告。显式设置 `DSH_PERMISSION_MODE` 可覆盖。
- **进程树终止**。Windows 上用 `taskkill /T /F`，因为 `child.kill()` 只是对直接子进程做 `TerminateProcess`。POSIX 上服务端以 detached 方式启动，信号发给整个进程组：先 SIGTERM，宽限期后升级为 SIGKILL。服务端不走优雅 dispose 路径；会话数据按事件逐条写入 JSONL，所以被杀掉的服务端不会丢失任何已记录的内容。
- **外部链接**。任何打开新窗口或导航离开服务端 origin 的行为都转交系统浏览器，且限定 `http(s)`；无法解析的目标直接丢弃。
- **工作区语义**沿用 CLI 的：调用目录即默认项目根。从桌面快捷方式启动会以外壳的 cwd 为起点，因此建议从项目目录打开应用，或在 GUI 里选择 Workspace。
- **日志**。服务端 stdout 以 `[dsh web]` 前缀转发；从终端启动应用可同时看到两路输出。

## 自定义改动

相对上游 shell 的本地改动：

- **DeepSeek 蓝色主题**：弹窗、下拉菜单、提示气泡、输入框、按钮（含"新会话"）、外观选中态、插件配置卡片等浮层，从主题默认的中性灰改为 DeepSeek 品牌蓝（深蓝玻璃色系），与窗口玻璃底色统一。通过向托管页面注入 CSS 变量实现（`src/glass.ts`），暗/亮主题各一套配色。
- **背景透明度滑块**：设置 → 通用设置 → 外观 下方新增「背景透明度」滑块（40%–100%），拖动即时生效并持久化；标题自动跟随界面语言（中/英）。实现依赖新增的沙箱 preload（`src/preload.cts`），经 IPC 与主进程通信。
- **托盘菜单精简**：托盘右键菜单移除了 Opacity / Theme 两个入口，只保留「打开窗口 / 退出」；主题与透明度统一在设置页内管理。
- **图标**：窗口与托盘图标改为 DeepSeek 品牌蓝（`#4176e6`）；`scripts/generate-icons.mjs` 支持 `DSH_FAVICON` 环境变量指定 favicon 源路径，并修复了暗色模式下图标被强制渲染成白色的问题。
- **修复**：托盘调整透明度/主题不生效 —— 多次注入的玻璃守卫脚本会堆叠多个 MutationObserver 互相覆盖取值；现在每次注入先断开上一个观察器，实时调整可立即生效。

## 测试

```sh
npm test        # 28 个无密钥用例：命令解析、就绪行解析、HTTP 轮询
npm run typecheck
```

## 来源

外壳、launcher 与 process-tree 原语是在一个 harness fork 中开发并已贡献回上游；本仓库是其独立抽取版本。组织内相关的独立外壳实现：[dsh-desktop](https://github.com/dsh-external/dsh-desktop)（Go/Wails，Windows）、[dsh-desktop-mac](https://github.com/dsh-external/dsh-desktop-mac)（Swift/WKWebView）、[deepseek-harness-desktop](https://github.com/dsh-external/deepseek-harness-desktop)（Wails + Node SEA）。

## 许可

[BSD 3-Clause](LICENSE)，与 harness 一致。
