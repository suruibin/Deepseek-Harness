/**
 * dsh-desktop Electron main: single-instance lock, spawn `dsh web` via the
 * launcher, wait for readiness, host the GUI in a standalone window, and keep
 * the server alive in the tray after the window closes. Closing the window
 * hides it (tray residency); quitting via the tray menu terminates the server
 * child and exits.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { killProcessTree } from './process-tree.ts'
import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
// node-pty is a native module; loaded lazily so a missing/broken build does
// not break the shell. The embedded terminal feature degrades gracefully.
const require_ = createRequire(import.meta.url)
import { alphaControlScript, ambientStyleScript, glassGuardScript, glassWindowOptions, loadGlassSettings, saveGlassSettings, streamingGuardScript, themeScript, type GlassTheme } from './glass.ts'
import { featureControlScript, glassControlsScript, inputHistoryScript, themeSettingsScript, whaleSprayScript } from './misc-scripts.ts'
import { terminalScript } from './terminal-scripts.ts'
import { wallpaperControlScript, wallpaperLayerScript } from './wallpaper-scripts.ts'
import { detectExistingServer, resolveWebLaunch, waitForHttpOk, waitForReadyLine, childExited } from './launcher.ts'
import { restartWebServer, spawnReaper, STDERR_TAIL_LIMIT } from './server-restart.ts'
import { mergePlugins, pluginsCssScript, readPluginDir } from './plugins.ts'
import { PtyRegistry } from './pty-registry.ts'
import { repairSessionLogs } from './session-repair.ts'
import { registerSessionManageIpc } from './session-manage.ts'
import { registerDesktopIpc } from './desktop-ipc.ts'
import { sessionManageScript } from './session-manage-client.ts'

const APP_ID = 'ai.deepseek.dsh-desktop'
const WINDOW_TITLE = 'DSH Desktop'

// The hosted SPA is a dark theme; Chromium's native form controls (e.g. the
// <select> popup lists in 主题设置 → 光标特效) otherwise render their popup
// menus in the system's light palette (a pale gray slab on the dark glass
// panel — user: 弹出的颜色不适配). Forcing the dark theme makes every
// Chromium-drawn UI (select popups, scrollbars) follow the glass theme.
nativeTheme.themeSource = 'dark'

// GPU acceleration is enabled: on this machine it renders ~3x faster than
// software rendering (459ms/frame vs 1373ms/frame for animated redraws) with
// a stable GPU process, so the fullscreen settings panel stays usable. If a
// future regression reintroduces renderer pegging/crashes (blank window),
// restore: app.disableHardwareAcceleration() + appendSwitch('disable-gpu').
//
// backdrop-filter needs a GPU compositor. This machine's niri Wayland session
// has no Vulkan ('--ozone-platform=wayland' is not compatible with Vulkan),
// so without intervention Chromium falls back to plain software rendering,
// where backdrop-filter is silently dropped (verified: blur 0px vs 100px
// screenshots are pixel-identical; the popup glass looked unfrosted).
//
// Two ANGLE backends were measured on this machine:
//   - swiftshader (software GL): blur works, but the GPU process pegs at
//     300-660% CPU — the whole interface janks.
//   - gl (hardware Mesa EGL, renderD128): blur works AND the GPU process
//     idles at ~20% CPU. 15-30x cheaper. Chosen below.
// Must be set before the GPU process spawns, hence appendSwitch at module scope.
if (process.platform !== 'win32' && process.platform !== 'darwin') {
  app.commandLine.appendSwitch('use-angle', 'gl')
}
// Transparent windows need a 32-bit (ARGB) visual. The X server niri exposes
// (xwayland-satellite) has none, so on Xwayland the translucent window falls
// back to opaque 24-bit and the frosted glass is lost. The ozone platform
// must be picked at process start — the launcher (scripts/run-electron.mjs)
// sets ELECTRON_OZONE_PLATFORM_HINT=wayland when a Wayland session is
// present; packaged builds need the same env var or an explicit
// --ozone-platform=wayland argument.
/**
 * The repository root in dev, the asar root when packaged. Resolved from
 * `app.getAppPath()` rather than derived from `import.meta.url`: the built
 * entry lives at `lib/main.js`, so a dirname walk would land on `lib` —
 * breaking the packaged icon paths and the dev runDir. `getAppPath()` is the
 * app root Electron itself resolves (`electron .` in dev; the asar root when
 * packaged) and is safe to call at module scope.
 */
const PACKAGE_DIR = app.getAppPath()

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let server: ChildProcess | undefined
let serverUrl: URL | undefined
let quitting = false
// Set by the first fatal() so one root cause cannot show duplicate modal
// dialogs or dispatch process-tree teardown twice.
let failing = false
// A focus request (second launch, tray click) that arrived while the server
// was still booting and no window existed yet; honored once boot completes.
let pendingFocus = false
// Glass styling state: the current Linux tint alpha, theme preference, and
// the stored wallpaper file name (or null).
const userData = app.getPath('userData')
const initialGlass = loadGlassSettings(userData)
let windowAlpha = initialGlass.alpha
let windowTheme: GlassTheme = initialGlass.theme
let wallpaperFile: string | null = initialGlass.wallpaper
// xterm UMD + CSS are ~1MB of static text read at injection; cached after the
// first load so repeated page navigations do not re-read them from disk.
let xtermAssets: { js: string; css: string } | null = null

/** Persist the current glass settings (alpha, theme, wallpaper). */
function saveGlass(): void {
  saveGlassSettings(userData, { alpha: windowAlpha, theme: windowTheme, wallpaper: wallpaperFile })
}

function iconPath(): string {
  return join(PACKAGE_DIR, 'build', 'icon.png')
}

function trayIconPath(): string {
  return join(PACKAGE_DIR, 'build', 'tray-icon.png')
}

/**
 * Terminate the server child and its tree. The platform-specific logic lives
 * in `process-tree.ts` — Windows: taskkill /T, because
 * `child.kill()` is `TerminateProcess` of the direct child only; POSIX:
 * SIGTERM against the server's detached process group (a negated pid reaches
 * the whole tree), escalated to SIGKILL after a five-second grace. This
 * wrapper only owns the desktop log prefix, preserving the historical message
 * format.
 * @param pid - the process to terminate.
 */
function killTree(pid: number): Promise<void> {
  return killProcessTree(pid, {
    logger: (message) => { console.error(`[dsh-desktop] killTree ${message}`) },
  })
}

/**
 * (Re)inject the glass styling into the hosted page. The previous injection is
 * removed first so repeated calls replace instead of stacking rules; a stale
 * key after navigation is swallowed. Errors are non-fatal: the page simply
 * keeps its previous styling and the next load re-injects.
 * @param window - the window whose page carries the glass tint.
 * @param alpha - the Linux tint opacity (ignored on Windows/macOS).
 */
/**
 * Force the hosted page's theme to the preference. Runs before the glass guard
 * is installed so the tint color matches the theme that will be visible.
 * @param window - the window whose page carries the theme.
 */
async function applyGlassTheme(window: BrowserWindow, theme: GlassTheme): Promise<void> {
  try {
    await window.webContents.executeJavaScript(themeScript(theme))
  } catch {
    // Page not ready; the next did-finish-load re-applies it.
  }
}

/**
 * (Re)apply the full glass styling to a window: force the theme first, then
 * install the self-healing tint guard (which keys off the theme attribute),
 * then (re)mount the wallpaper layer under the translucent canvas.
 * @param window - the window to restyle.
 */
async function applyGlass(window: BrowserWindow): Promise<void> {
  await applyGlassTheme(window, windowTheme)
  await injectBatch(window, [() => glassGuardScript(windowAlpha), wallpaperLayerScript])
}

/**
 * Execute one injection script in the hosted page. Errors are non-fatal —
 * the next did-finish-load re-injects every script anyway.
 * @param window - the window hosting the page.
 * @param script - a script producer (functions are called so parameterized
 * scripts like `glassGuardScript(alpha)` stay possible).
 */
async function inject(window: BrowserWindow, script: () => string): Promise<void> {
  try {
    await window.webContents.executeJavaScript(script())
  } catch {
    // Page not ready; the next did-finish-load re-applies it.
  }
}

/**
 * Execute a batch of injection scripts in ONE executeJavaScript round-trip
 * (the injected scripts re-run on every load/navigation, and a per-script
 * round-trip multiplies that cost). Each script is wrapped in its own
 * try/catch so a failing script does not abort the rest, mirroring the
 * per-call isolation of inject().
 * @param window - the window hosting the page.
 * @param scripts - script producers, run in array order.
 */
async function injectBatch(window: BrowserWindow, scripts: (() => string)[]): Promise<void> {
  if (scripts.length === 0) return
  const body = scripts.map((s) => `try { ${s()} } catch {}`).join(';\n')
  await inject(window, () => body)
}

/**
 * Inject user plugins into the hosted page. Plugins are CSS/JS files loaded
 * from two directories, merged with user files taking precedence over the
 * built-in ones (see `src/plugins.ts`):
 *   - <appPath>/plugins      — ships with the package (the asar in release
 *     builds), so every install gets the built-in fixes.
 *   - <userData>/plugins     — user-owned, overrides the built-ins; lets a
 *     user restyle the shell without touching the package.
 * CSS is mounted as one <style> node; each JS file runs in page context.
 * Errors are non-fatal: the shell keeps running without plugins, and the
 * next did-finish-load re-injects.
 * @param window - the window hosting the page.
 */
async function injectPlugins(window: BrowserWindow): Promise<void> {
  try {
    const merged = mergePlugins(
      readPluginDir(join(PACKAGE_DIR, 'plugins')),
      readPluginDir(join(userData, 'plugins')),
    )
    const css = merged.filter((f) => f.name.endsWith('.css'))
    if (css.length > 0) {
      await window.webContents.executeJavaScript(pluginsCssScript(css.map((f) => f.content)))
    }
    for (const file of merged) {
      if (!file.name.endsWith('.js')) continue
      try {
        await window.webContents.executeJavaScript(file.content)
      } catch {
        // A broken user JS plugin must not break the shell.
        console.error(`[dsh-desktop] plugin ${file.name} failed to execute`)
      }
    }
  } catch {
    // Plugin load failed; the next did-finish-load re-injects.
  }
}

/**
 * Inject the embedded terminal: loads the xterm UMD bundle + CSS into the
 * page, then mounts the terminal toggle/surface UI. The UMD files are read
 * from node_modules at build time and passed through executeJavaScript so no
 * bundler or extra packaging step is needed. Errors are non-fatal.
 * @param window - the window hosting the page.
 */
async function injectTerminal(window: BrowserWindow): Promise<void> {
  try {
    // A fresh page load means a fresh panel: drop every pty from the previous
    // page (a hard refresh cannot reach them through the old injected script,
    // so they would leak the per-window cap otherwise). Panel hide/show and
    // tab switches are page-internal and keep their sessions.
    ptyRegistry.disposeAll()
    attachedTermTabs.clear()
    // The UMD bundle + CSS are ~1MB of static text; read them once and reuse
    // across page loads instead of re-reading from disk on every navigation.
    let assets = xtermAssets
    if (assets === null) {
      const { readFileSync } = await import('node:fs')
      assets = xtermAssets = {
        js: readFileSync(require_.resolve('xterm/lib/xterm.js'), 'utf8'),
        css: readFileSync(require_.resolve('xterm/css/xterm.css'), 'utf8'),
      }
    }
    // xterm UMD expects a browser global; executeJavaScript gives it one.
    await window.webContents.executeJavaScript(assets.js)
    await window.webContents.executeJavaScript(
      '(() => { const s = document.createElement(\'style\'); s.id = \'dsh-xterm-style\'; s.textContent = ' + JSON.stringify(assets.css) + '; document.head.appendChild(s); })()',
    )
    await window.webContents.executeJavaScript(terminalScript())
  } catch {
    // Terminal engine or UI unavailable; the shell keeps running without it.
  }
}

/**
 * Change the window's glass tint and persist the choice. Driven by the
 * settings-page slider (via the `dsh:set-alpha` IPC) and by the tray menu.
 * @param alpha - the new tint opacity in [0, 1].
 */
function setWindowAlpha(alpha: number): void {
  if (alpha === windowAlpha) return
  windowAlpha = alpha
  saveGlass()
  if (mainWindow !== undefined) void applyGlass(mainWindow)
}

function showWindow(): void {
  if (mainWindow !== undefined) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (serverUrl !== undefined) createWindow(serverUrl)
  else pendingFocus = true
}

// ── Embedded terminal (PTY) ─────────────────────────────────────────────
// Multi-tab PTY sessions, one shell process per injected-panel tab id, with
// better-sidebar semantics (transcript replay on attach, exited respawn,
// per-window tab cap). Data flows to the renderer via 'dsh:term-data'
// (tagged with the tab id); input and resize come back via IPC. The
// registry dies with the app; on quit it is disposed explicitly.
const ptyRegistry = new PtyRegistry()

/** Tab ids whose push listeners are already attached to the registry. */
const attachedTermTabs = new Set<string>()

function pushToWindow(channel: string, payload: unknown): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/**
 * Open a URL in the system browser — but only http(s) links: the GUI must
 * not be able to launch arbitrary programs via `file://` or a custom
 * protocol, and a navigation target that is not a parseable URL is dropped
 * too. `shell.openExternal` is fire-and-forget; its rejection must not
 * become an unhandled rejection in the Electron main process.
 * @param raw - the raw URL from the web contents.
 */
function openExternal(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // new URL(string) throws only SyntaxError for unparsable input; ignore.
    console.warn(`[dsh-desktop] ignoring unparsable external URL: ${raw}`)
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.warn(`[dsh-desktop] ignoring non-http(s) external URL: ${raw}`)
    return
  }
  void shell.openExternal(raw).catch((error: unknown) => {
    console.error(`[dsh-desktop] failed to open ${raw}: ${error instanceof Error ? error.message : String(error)}`)
  })
}

function createWindow(url: URL): void {
  const window = new BrowserWindow({
    ...glassWindowOptions(process.platform),
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    title: WINDOW_TITLE,
    show: false,
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(PACKAGE_DIR, 'lib', 'preload.cjs'),
    },
  })
  mainWindow = window
  // Fullscreen perf: a TRANSPARENT window composites its whole surface with
  // alpha on every repaint, which under Wayland software rendering (GPU is
  // disabled, see above) makes fullscreen + busy panels (settings) janky.
  // In fullscreen the window covers the output, so there is nothing behind
  // it to see through — make the shell opaque for the duration and restore
  // transparency on exit.
  if (process.platform !== 'darwin') {
    window.on('enter-full-screen', () => window.setBackgroundColor('#0f1117'))
    window.on('leave-full-screen', () => window.setBackgroundColor('#00000000'))
  }
  // Show the window. The window starts with show:false and a transparent
  // shell; the SPA paints its own translucent background, so there is no
  // white flash. Two independent triggers guarantee the window appears even
  // when ready-to-show is delayed or never fires under Wayland software
  // rendering (previously the window stayed hidden until the tray icon was
  // clicked):
  //   1. ready-to-show — fires when the first paint is ready.
  //   2. did-finish-load — fires when the page has loaded; show() is idempotent.
  const showWindowWhenReady = (): void => {
    if (window.isVisible()) return
    window.show()
  }
  window.once('ready-to-show', showWindowWhenReady)
  window.webContents.once('did-finish-load', showWindowWhenReady)
  // The SPA's theme plugin loads asynchronously after the document finishes
  // and re-applies its own theme attribute, clobbering an eager injection.
  // Debounce the glass application until the page has settled.
  let glassTimer: NodeJS.Timeout | undefined
  const scheduleGlass = (): void => {
    if (glassTimer !== undefined) clearTimeout(glassTimer)
    glassTimer = setTimeout(() => {
      void applyGlass(window)
      // Injection order matters: everything must follow applyGlass's theme.
      void injectBatch(window, [
        themeSettingsScript,
        alphaControlScript,
        wallpaperControlScript,
        featureControlScript,
        glassControlsScript,
        ambientStyleScript,
        inputHistoryScript,
        whaleSprayScript,
        streamingGuardScript,
        sessionManageScript,
      ])
      void injectPlugins(window)
      void injectTerminal(window)
    }, 800)
  }
  window.webContents.on('did-finish-load', scheduleGlass)
  window.webContents.on('did-navigate', scheduleGlass)
  void window.loadURL(url.href).catch((error: unknown) => {
    // The server may have died right after readiness; a failed load must
    // not crash the main process, the window just stays on its error page.
    console.error(`[dsh-desktop] failed to load ${url.href}: ${error instanceof Error ? error.message : String(error)}`)
  })
  window.on('close', (event) => {
    // Tray residency: closing hides the window and keeps the server running.
    if (quitting) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  // The GUI is a single-page app; anything that opens a new window or
  // navigates away from the server origin belongs in the system browser.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternal(target)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin === url.origin) return
    } catch {
      // new URL(string) throws only SyntaxError for unparsable input; such a
      // target is not ours and is rejected below.
    }
    event.preventDefault()
    openExternal(target)
  })
}

/**
 * Build the tray context menu. Glass opacity and page theme are controlled
 * from the hosted settings page (通用设置 → 外观), so the tray only carries
 * the window and quit actions.
 */
function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open Window', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit() } },
  ])
}

function createTray(): void {
  const image = nativeImage.createFromPath(trayIconPath())
  const icon = image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip(WINDOW_TITLE)
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', showWindow)
}

/**
 * Expose the minimum file-based control used by the built Electron lifecycle
 * smoke. Server resolution, spawn, readiness, window creation, and teardown
 * remain the shipping path; the test hook only reports readiness and requests
 * the same `app.quit()` action as the tray menu.
 */
async function exposeLifecycleTestControl(): Promise<void> {
  if (process.env.DSH_DESKTOP_TEST !== '1') return
  const serverPid = server?.pid
  if (serverPid === undefined) {
    throw new Error('dsh-desktop: lifecycle test control requires a live server pid')
  }
  const quitFile = process.env.DSH_DESKTOP_TEST_QUIT_FILE
  if (quitFile !== undefined) {
    const { statSync } = await import('node:fs')
    const timer = setInterval(() => {
      let current
      try {
        current = statSync(quitFile)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        clearInterval(timer)
        fatal(new Error(`dsh-desktop: lifecycle quit probe failed: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
      if (!current.isFile() || current.size === 0) return
      clearInterval(timer)
      app.quit()
    }, 100)
  }
  // Emit readiness only after the optional quit poller is registered, so a
  // harness reacting immediately cannot create the signal before observation.
  process.stdout.write(`DSH_DESKTOP_READY ${String(serverPid)}\n`)
}

function fatal(error: Error): void {
  console.error(`[dsh-desktop] ${error.message}`)
  if (failing) return
  failing = true
  dialog.showErrorBox(WINDOW_TITLE, error.message)
  // app.exit() skips before-quit; kill the server tree and wait for the
  // dispatch to land so a boot failure cannot leave an orphaned `dsh web`
  // (the reaper only guards hard kills).
  quitting = true
  if (server?.pid !== undefined) {
    void killTree(server.pid).then(() => { app.exit(1) })
  } else {
    app.exit(1)
  }
}

async function boot(): Promise<void> {
  const launch = resolveWebLaunch({ env: process.env })
  // 启动 dsh web 前自动检测并修复损坏的会话日志 (seq 缺口 / 多写流交错),
  // 否则 GUI 打开历史会话时会报 "corrupt session log: seq gap" 而失败。
  // 修复只依赖磁盘上的会话文件，与 server 启动无依赖，故用 setImmediate
  // 让它随 server 启动并发执行，不再同步阻塞启动路径（大量会话时省去整批
  // 同步读盘）。server 在就绪前不会写会话日志，修复窗口内无并发写者。
  setImmediate(() => {
    try {
      const report = repairSessionLogs()
      if (report.fixed > 0) {
        console.log(`[dsh-desktop] 自动修复 ${report.fixed} 个损坏的会话日志: ${report.details.filter((d) => d.fixed).map((d) => d.id).join(', ')}`)
      } else if (report.brokenRemaining > 0) {
        console.warn(`[dsh-desktop] ${report.brokenRemaining} 个会话日志损坏且无法自动修复`)
      }
    } catch (error) {
      console.warn(`[dsh-desktop] 会话日志自动修复失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  // 检测是否已有 dsh web 实例在运行（如常驻 GUI）。两个 dsh web 共享
  // ~/.dsh/sessions 却无跨进程写锁，并发写同一会话会产生 seq 重复/缺口并
  // 损坏历史；复用已有实例从源头消除这类损坏。
  try {
    const existing = await detectExistingServer({ env: process.env })
    if (existing !== undefined) {
      console.log(`[dsh-desktop] 检测到已运行的 dsh web 实例 ${existing.href}，直接复用（不启动第二个实例，避免并发写入会话存储）`)
      serverUrl = existing
      Menu.setApplicationMenu(null)
      createWindow(existing)
      createTray()
      if (pendingFocus) {
        pendingFocus = false
        showWindow()
      }
      // 复用模式没有本进程管理的 server 进程，测试钩子（依赖 server pid）不适用。
      return
    }
  } catch (error) {
    console.warn(`[dsh-desktop] 已有实例检测失败，继续自启: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (launch.env.DSH_PERMISSION_MODE !== undefined && (process.env.DSH_PERMISSION_MODE === undefined || process.env.DSH_PERMISSION_MODE === '')) {
    console.warn(`[dsh-desktop] Windows has no harness confinement backend; using ${launch.env.DSH_PERMISSION_MODE} permission mode (approval prompts are disabled). Set DSH_PERMISSION_MODE to override.`)
  }
  console.log(`[dsh-desktop] launching dsh web (${launch.source}): ${launch.command} ${launch.args.join(' ')}`)
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...process.env, ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX: detaching makes the child a process-group leader so both killTree
    // and the reaper can signal the whole tree with a negated PID; Windows
    // stays attached and tree-kills with taskkill /T instead.
    detached: process.platform !== 'win32',
  })
  server = child
  let ready = false
  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT)
  })
  child.on('error', (error) => {
    // Spawn failure (command not found etc.): no child exists to clean up.
    fatal(new Error(`dsh-desktop: failed to spawn dsh web via ${launch.source}: ${error.message}`))
  })
  child.on('exit', (code, signal) => {
    // Attached immediately so a crash during readiness cannot go unreported;
    // before readiness the readiness wait itself fails (the stream ends), so
    // the boot error path owns the message.
    if (quitting || !ready) return
    void dialog.showMessageBox({
      type: 'error',
      title: WINDOW_TITLE,
      message: 'dsh web exited unexpectedly',
      detail: `code ${String(code)} signal ${String(signal)}\n${stderrTail}`,
    }).finally(() => { app.quit() })
  })
  // No OS delivers a parent-death notification, so the reaper polls this
  // process and tree-kills the server if the main is ever hard-killed (Task
  // Manager, taskkill, a crash), so `dsh web` cannot outlive its window on any
  // platform. Windows kills via taskkill /T; POSIX signals the server's
  // process group (the server is detached, so a negated PID reaches the whole
  // tree). The reaper stays alive across a graceful quit too: it detects the
  // main's exit and finishes the cleanup even if the quit path's own killTree
  // races the exit. It is deliberately not killed on quit. Like the server, it
  // must live outside Electron's process group: a terminal Ctrl+C signals the
  // group, and taking the reaper with it would kill the hard-kill cleanup
  // exactly when it is needed (detached + unref below).
  spawnReaper(child.pid ?? 0)
  // Readable stream: yield strings, and a multibyte character split across
  // chunks is reassembled by the decoder instead of mojibaked.
  child.stdout.setEncoding('utf8')
  let url: URL | undefined
  try {
    url = await waitForReadyLine(child.stdout, {
      onChunk: (chunk) => { process.stdout.write(`[dsh web] ${chunk}`) },
    })
    await waitForHttpOk(url)
    // A 200 on the readiness port is not necessarily ours: if the child
    // exited while the poll ran, some other local server may have answered.
    // Hosting a stranger's process would be a mistake, so fail the boot
    // instead (the catch below owns the fatal dialog).
    if (childExited(child)) {
      throw new Error(`dsh-desktop: dsh web exited (code ${String(child.exitCode)} signal ${String(child.signalCode)}) while its port was verified; not adopting the server`)
    }
    ready = true
    serverUrl = url
  } catch (error) {
    fatal(error instanceof Error ? new Error(`${error.message}\n${stderrTail}`) : new Error(String(error)))
  }
  // `url` survives a later failure in the same try (HTTP readiness failure or
  // child exit after binding). Only create the UI after the complete readiness
  // boundary succeeds, while fatal() tears the failed server down.
  if (!ready || url === undefined) return
  Menu.setApplicationMenu(null)
  createWindow(url)
  createTray()
  // A focus request cached while the server was booting (second launch, tray
  // click) is honored now that the window exists; the request would have been
  // silently lost otherwise. Deliberately after createWindow, so the cached
  // request surfaces this one window instead of spawning a second.
  if (pendingFocus) {
    pendingFocus = false
    showWindow()
  }
  await exposeLifecycleTestControl()
}

// Tray residency means the app outlives its window; a second launch must focus
// the existing window instead of starting a second server.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (process.env.DSH_DESKTOP_TEST === '1') {
      process.stdout.write('DSH_DESKTOP_SECOND_INSTANCE\n')
    }
    showWindow()
  })
  app.setAppUserModelId(APP_ID)
  // Desktop IPC: settings glass, embedded terminal, folder browser, backup,
  // git-status, wallpaper, terminal-state persistence, clipboard, and the
  // in-place web restart. Session archive/restore/recycle-bin stays in its
  // own module below.
  registerDesktopIpc({
    userData,
    packageDir: PACKAGE_DIR,
    mainWindow: () => mainWindow,
    getWindowAlpha: () => windowAlpha,
    setWindowAlpha,
    pushToWindow,
    ptyRegistry,
    attachedTermTabs,
    getWallpaperFile: () => wallpaperFile,
    setWallpaperFile: (file: string | null) => {
      wallpaperFile = file
      saveGlass()
    },
    restartWebServer: () => restartWebServer({
      serverUrl: () => serverUrl,
      server: () => server,
      mainWindow: () => mainWindow,
      setServer: (child) => { server = child },
      setServerUrl: (url) => { serverUrl = url },
    }),
  })
  // 会话删除 / 已归档 / 回收站 IPC（preload 桥 window.dshDesktop.session）。
  registerSessionManageIpc()
  app.whenReady().then(boot).catch(fatal)
  app.on('before-quit', (event) => {
    // More than one path can request quit. Keep the first tree-kill as the
    // single teardown owner and prevent later before-quit events from exiting
    // Electron while that asynchronous kill is still in flight.
    if (quitting) {
      if (server?.pid !== undefined) event.preventDefault()
      return
    }
    quitting = true
    // Terminate every embedded terminal shell alongside the server.
    ptyRegistry.disposeAll()
    attachedTermTabs.clear()
    if (server?.pid !== undefined) {
      // Prevent immediate exit and await the process-tree completion boundary
      // so the server child and its descendants are gone before Electron exits.
      // The reaper is the hard-kill backup: if this path is interrupted
      // (crash, forced exit), the reaper performs the same tree kill.
      event.preventDefault()
      void killTree(server.pid).then(() => { app.exit(0) })
    }
  })
  // Tray residency: the app outlives its window by design, so a destroyed
  // window must not trigger Electron's default quit.
  app.on('window-all-closed', () => {})
}
