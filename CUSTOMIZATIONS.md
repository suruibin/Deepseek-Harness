# Fork 自定义修改清单（供上游更新时同步）

> 基座：上游 dsh-desktop-electron 初始 5 提交（e67ac22…81a3eed）。
> 本 fork：95 个提交，54 个文件改动，+15046 行。上游基座本身很小，
> 绝大部分代码是 fork 新增；本 fork 是自有产品线（无可 rebase 的上游，
> 详见「八、上游拓扑」），「更新同步」= dsh web 本体（npm 包，独立演进）
> 升级时对注入脚本做回归测试。

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
| VOzbGW_ | 设置弹窗 overlay（:has 穿透修复；z 抬至 2147482000 压右侧面板） |
| nUhMVa_ | 第三方插件 dshmarket 的 UI 模块（确认弹窗 confirmModal/lightbox 等）；confirm 弹窗走宿主 _root_o6lrb_ portal，lightbox 走自带 body 级 host（data-dsh-market-portal，靠 body 末位 DOM 顺序压宿主弹窗，被壳的 overlay 抬升压死后在 glass.ts 反抬 2147482100） |
| data-dsh-market-portal | dshmarket 自建 body 级 portal host（lib/client.js marketPortalHost），壳反抬 z:2147482100 |
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

## 八、上游拓扑（2026-10-25 实测勘正）

- 本 fork 无可 rebase 的上游壳：基座 5 提交（e67ac22…81a3eed）在已知候选上游中均无祖先——
  anywhere-labs/dsh-desktop（monorepo，13809 提交）与 deepseek-ai/deepseek-harness（23934 提交，
  即 dsh web 本体仓库，含 dsh-v0.2.1-rc.x 标签）中都不存在基座的 reaper.ts/process-tree.ts，
  基座提交信息亦搜不到（fork 为重新导入，无共同祖先，merge-base 为空）
- 上游桌面壳已彻底重写：deepseek-ai/deepseek-harness 的 apps/desktop/（72 文件，backend-controller/
  host-process 等新架构，持续活跃）与本 fork 的 5 文件老架构（launcher/reaper/process-tree）是
  两套代码。「同步壳」= 全量移植（数天级大工程），非 rebase
- monorepo anywhere-labs/dsh-desktop 通过 .gitmodules submodule 钉 deepseek-ai/deepseek-harness
  （1f81c04），是壳的孵化地/参考实现；其 .agents/notes/architecture/ 有桌面架构笔记
- 本地已配 remote：origin=suruibin/Deepseek-Harness（自有产品线），
  upstream=deepseek-ai/deepseek-harness（仅用于追踪 dsh web 版本与标签）

**结论：壳是自有产品线，不跟上游合并。真正的「更新同步」= dsh web 本体升级后的注入回归** ↓

## 九、更新同步操作顺序（dsh web 升级时执行）

1. 手动升级 dsh 前先记当前版本（dsh-update.timer 保持禁用，上游自动升级曾引发事故）
2. 升级后跑 tsc + 88 测试
3. 启动后 CDP 核对「二」表中的类名，失效项更新选择器
4. 检查 dsh web 认证模型是否变化（token 栅栏/签名串，对应 upstream 仓库 dsh-v* 标签的改动）
5. 回归视觉清单：三滑块实时生效、弹窗族毛玻璃、代码块复制行、问题卡片、图标位置
6. 回归浮层层级（见「十」）：设置内打开安装确认/图片预览/下拉均不被遮罩压住
7. 重打包 AppImage 部署 ~/Software/Deepseek.AppImage
8. 如需参考上游壳的新能力，读 upstream 仓库 apps/desktop/ 对应实现，按需移植单点

## 十、弹层层级战争——rc.3 portal 反抬体系（2026-10-25 实战记录）

**背景**：壳为压住右侧面板把设置 overlay（VOzbGW_overlay，body 直接子节点）抬到 z:2147482000。
rc.3 起弹层走「body 级 portal + 高 z」路线，靠同 z/高 z 压过宿主，逐族被我们的 2000 压死。
用户可见症状：**弹窗/浮层画在设置界面后面、点不到**。解法集中在 glass.ts（~L1163-1189），
一律反抬到 **2147482100**（居 overlay 之上、光标特效画布 2147482999 之下）。

### 层级地图（body 直接子节点，从低到高）

| 层 | z | 说明 |
|---|---|---|
| 壁纸层 | -1 | 壳注入 |
| #root 应用 | auto | dsh web 主体 |
| VOzbGW_overlay（设置遮罩+面板） | 2147482000 | 壳的规则；VOzbGW_panel 内 z:1 |
| `body > [class*="_root_o6lrb_"]` | 2147482100 | rc.3 模态 portal 模块（安装确认弹窗等，上游 z:1000 靠同 z 后者胜） |
| `body > [class*="_root_"]:has(> [role="dialog"])` | 2147482100 | 兜底：上游将来换哈希但内容带 role=dialog |
| `body > [data-dsh-market-portal]` | 2147482100 | dshmarket 插件浮层 host（见下） |
| 光标特效 canvas | 2147482999 | 壳注入，最顶层 |

### 已修案例（快速索引）

1. **安装确认弹窗被压**（rc.3 回归，commit 296b32b）：上游把确认弹窗 portal 到
   `_root_o6lrb_` wrapper（上游 z:1000，靠同 z DOM 后者胜压 overlay:1000），被 2000 压死
   → 反抬 2100（`role=dialog` 语义句柄 + 哈希双规则）。
2. **dshmarket 图片灯箱被压**（第三方插件 dshmarket v1.70.2）：lightbox(z:10000) portal 到
   自建 body 级 host `data-dsh-market-portal`（`lib/client.js marketPortalHost()`，class notranslate），
   插件**不设 z**，靠「host 永远重新 append 到 body 末位」的 DOM 顺序压宿主弹窗
   （源码注释明说此设计）→ 被 2000 压死 → host 反抬 2100。
   修复教训：第一版只写 `z-index` 无效，因为 **host 是 `position:static`——z-index 对 static
   元素不参与层叠**（getComputedStyle 会回显值但实测无效，探测时差点被骗）。必须
   `position: relative` + z 一起写；relative 不会改 `position:fixed` 子元素的视口锚定
   （只有 transform/filter 会）。

### 下次浮层被压的排查路径

1. 复现：设置弹窗开着时触发目标浮层，`document.elementFromPoint(中心)` 看命中的是谁
2. 定位挂载：从 dsh web 前端包（`@deepseek-ai/dsh-web-frontend/dist/assets/*.css` 找
   `_root_` 哈希）或插件包（`~/.dsh/profiles/web/node_modules/<pkg>/client/client.js`
   `grep createPortal`/`Host`）确认浮层 portal 到哪、自身 z 是多少
3. 套反抬：body 级句柄 + `position:relative`（若宿主 static）+ z:2147482100，
   语义句柄（role=dialog/data 属性）优先于哈希（哈希随上游变）
4. A/B 验证：合成同构浮层，三点 elementFromPoint（中心/边角/上缘），
   有规则全命中浮层、去规则命中设置内容 = 修复成立

### 复现/验证脚本骨架（CDP，30 秒）

```js
// 1. 打开设置弹窗（账号菜单 → Settings）
// 2. 合成与真实结构一致的浮层：
const host = document.createElement('div')
host.setAttribute('data-dsh-market-portal', '')          // 换成目标浮层的 body 级标识
const lb = document.createElement('div')
lb.className = 'nUhMVa_lightbox'                          // 换成目标浮层类名
lb.style.cssText = 'z-index:10000;position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.85)'
const img = document.createElement('img')
img.style.cssText = 'width:320px;height:200px;display:block;background:red'
lb.appendChild(img); host.appendChild(lb); document.body.appendChild(host)
// 3. 三点 elementFromPoint：图片中心 / 屏幕右上角(mask 区) / 图片上缘
//    修复后三点都应命中浮层内元素；去掉 data 属性（规则失配）应复现命中设置内容
```

### dshmarket 插件操作笔记（dev 复现用）

- 插件卡片点击 = 切换启用态（不是打开详情）；启用徽章「已停用」消失即已启用
- 「插件列表/插件市场」页签只在 tool-plugin-manager 启用后出现（dsh-market 入口在右侧面板）
- UI 内启用态被锁（profile patch 寻址），dev 复现要改
  `~/.dsh/profiles/web/cordis.patch.yml` 按 preset-ptc.config.plugins[].id 合并 disabled:false
