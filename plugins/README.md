# dsh-desktop plugins

样式/脚本插件目录。桌面壳启动后把本目录与用户目录的插件一并注入托管页面，
让定制外观**不需要重新编译**。

## 目录

| 目录 | 说明 |
| --- | --- |
| `<appPath>/plugins/` | 随包分发的内置插件（本目录）。打包后位于 asar 内。 |
| `<userData>/plugins/` | 用户插件。**同名文件覆盖内置**，其余按文件名顺序追加。 |

`userData` 即 Electron 的应用数据目录（Linux 通常为
`~/.config/dsh-desktop-electron/`）。

## 文件约定

- `*.css` — 注入为页面 `<style>` 节点（`#dsh-dt-plugin-style`），在玻璃样式之后，
  因此可覆盖内置样式。
- `*.js` — 注入后在页面上下文按文件名顺序执行，每个文件独立 try/catch，
  单个文件出错不影响其余插件与外壳本身。

## 内置插件

- `settings-icon.css` — 修复侧边栏收起（rail）状态下设置图标不可见：
  SVG path 无 `fill` 属性时回退到初始黑色，在深色玻璃 rail 上不可见；
  用 `currentColor` 跟随按钮文字色（深色=白，浅色=深）。

覆盖它：复制到 `~/.config/dsh-desktop-electron/plugins/settings-icon.css` 后修改即可。

## 示例：自定义插件

```bash
mkdir -p ~/.config/dsh-desktop-electron/plugins
# 例如让侧边栏更窄
printf '[class*="_sidebarCol"] { width: 240px !important; }\n' \
  > ~/.config/dsh-desktop-electron/plugins/narrow-sidebar.css
```

改完重新启动桌面壳（或触发页面重载）即生效。
