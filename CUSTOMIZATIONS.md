# Fork 自定义修改清单（供上游更新时同步）

> 基座：上游 dsh-desktop-electron 初始 5 提交（e67ac22…81a3eed）。
> 本 fork：95 个提交，54 个文件改动，+15046 行。上游基座本身很小，
> 绝大部分代码是 fork 新增；「更新同步」主要是两层：
> ① 上游壳（Electron 工程）出新版时 rebase；
> ② dsh web 本体（npm 包，独立演进）升级时回归测试注入脚本。

## 一、毛玻璃视觉体系 —— src/glass.ts（新增，1946 行）

核心资产，改动最重、对上游 DOM 最敏感的部分。

- 透明窗口 + 壁纸系统：`wallpaper.ts`/`wallpaper-scripts.ts`，glass-settings.json 存储，自动轮换
- 三个滑块（背景透明度/弹窗磨砂/面板磨砂）→ CSS 变量族 `--dsh-glass-*`（必须声明在 body 上，:root 求值不到）
- 表面统一（实心块 → 玻璃）：弹窗、tooltip、toast、设置卡片、模型菜单、轨迹面板、代码块、复制行、问题卡片(Mbwy4a_card)、悬停预览卡等数十处
- 布局修正：会话宽度 --dsh-chat-content-width（≥748px）、工作区行与输入卡 780px 同轴、右上角图标 translateX(-20px)、复制按钮 row-reverse 挪左、代码块 inset 描边+投影
- 已知陷阱（同步时必查）：嵌套 backdrop-filter 不渲染/累积加深；合成层无视 z-index（设置穿透 bug）；流式输出期间关 blur 防闪烁（data-dsh-streaming + inHoverArtifact）；outline 被滚动容器裁剪；--dsh-pane-give 接缝数学

## 二、注入脚本对上游类名的依赖 —— 同步最大风险点

所有注入按「类名子串」匹配，上游 UI 重构（类名哈希变化）会静默失效：

| 前缀/标识 | 归属 |
|---|---|
| Mbwy4a_ | 问题卡片（跳过本题/提交） |
| wSkVaW_ | 标题行右端图标、hero 工作区行 |
| pXSMma_ | 新会话工作区预览行 |
| bhn1Oq_ | 侧栏搜索/会话列表/折叠 rail |
| hHd-Xa_ | 侧栏（rc.1 时代，可能已变） |
| p-xYUq_ / _8_XoUG_ / _action_178r4_ | 消息操作行 |
| fV0t5q_ / _1p9O6q_ / lc-stat / lc-settings-card | 轨迹/上下文面板 |
| rtSEdW_ / eGUBIq_ / qSYn7G_ / YyYd_a_ | 设置卡片/tooltip |
| _7KE1Ra_ | 模型选择菜单 |
| VOzbGW_ | 设置弹窗 overlay（:has 穿透修复） |
| P3OORG_panel | 右侧面板壳 |
| __DSH_BOOT__ / "dsh web authentication required" | 实例探活标记（launcher.ts） |

上游更新后：跑 scripts/cdp.mjs 逐项核对类名是否仍存在，失效项改 glass.ts/misc-scripts.ts 里的选择器。

## 三、壳层生命周期 —— launcher.ts(+284) / main.ts(+556) / server-restart.ts / desktop-ipc.ts

- 实例复用与单实例：detectExistingServer 扫全量 body 找 __DSH_BOOT__；401+dsh 签名=活实例（token 栅栏，dsh 0.1.2-rc.1+ 认证模型）；绝不起第二实例（session.lock 并发写坏会话）
- token 播种：DSH_WEB_TOKEN 环境变量 → journalctl 扫 dsh-web 单元 ready 行取 ?token=；validateInstanceToken 校验后 /?token= 导航种 cookie
- 认证 cookie 膨胀修复：boot 清理全部 dsh-auth-* 再重种（防 431 空白窗口）
- 重启：restartServer 共享逻辑 + 防重入 + 退出看门狗（quitting/重启窗口期静默）；托盘菜单 Restart DSH；托盘名 app.setName('Deepseek Harness') + userData 钉回 ~/.config/dsh-desktop-electron
- 桌面功能持久化：dsh:features-get/set → desktop-features.json（localStorage 按随机端口隔离，重启丢开关）

## 四、新功能模块（全部为新增文件）

| 文件 | 行数 | 功能 |
|---|---|---|
| session-manage.ts + session-manage-client.ts | 1694 | 已归档会话面板（批量取消归档/删除、折叠态 rail 图标放置） |
| misc-scripts.ts | 1430 | 注入杂项：paneWidthScript(Fiber 改 setRightbar)、主题面板页脚、tooltip 引擎、宽度拖拽持久化 |
| terminal-scripts.ts | 1248 | 内嵌终端 |
| pty-registry.ts | 218 | pty 管理（16ms/64KiB 合并 IPC 推送） |
| wallpaper-scripts.ts + wallpaper.ts | 626 | 壁纸轮换 |
| git-status.ts | 200 | 文件面板 git 状态（1.5s TTL 缓存） |
| session-repair.ts (+worker) | 321 | 会话日志修复（zstd/JSONL，worker 线程） |
| plugins.ts + plugins/*.css | 151 | 插件加载器 + ui-fixes.css / settings-icon.css |
| mut-bus.ts | 69 | MutationObserver 事件总线 |

## 五、性能优化（同步时易被上游覆盖）

- 终端输出合并推送；transcript 超 2×limit 才裁回 1MiB（均摊 O(1)）
- 会话日志修复挪 worker；cookie 清理与启动并发
- git-status TTL 缓存；scheduleGlass 批量注入；xterm UMD 模块级缓存
- 同步阻塞 IPC → 异步；22 个 IPC handler 拆 desktop-ipc.ts

## 六、工程与打包

- scripts/build-appimage.sh（tsc → 注入语法校验 → electron-builder，绕过 pnpm verify-deps）
- scripts/afterPack.cjs 裁 locale（省 ~10MB）；版本 0.1.1；产物名 DeepSeek.AppImage
- scripts/backup-project.sh；开发工具 cdp.mjs / e2e-term.mjs / dsh-run|kill|watch.sh
- pnpm workspace 固化；.agent-presets mode 用 native/ptc/both（'code' 已废弃）

## 七、测试（6 个 spec，88 用例）

launcher（401 签名/token 解析）、git-status、pty-registry、session-repair、wallpaper、plugins。
上游更新后必跑：`npm run typecheck && npm test`，再 CDP E2E 核对类名。

## 八、更新同步操作顺序

1. git fetch 上游壳新提交 → rebase（冲突集中在 main.ts/launcher.ts/package.json）
2. 跑 tsc + 88 测试
3. 启动后 CDP 核对「二」表中的类名，失效项更新选择器
4. 检查 dsh web 认证模型是否变化（token 栅栏/签名串）
5. 回归视觉清单：三滑块实时生效、弹窗族毛玻璃、代码块复制行、问题卡片、图标位置
6. 重打包 AppImage 部署 ~/Software/Deepseek.AppImage
7. 禁用 dsh-update.timer 保持手动升级（上游自动升级曾引发事故）
