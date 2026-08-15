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
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from './electron-api.ts'
// node-pty is a native module; loaded lazily so a missing/broken build does
// not break the shell. The embedded terminal feature degrades gracefully.
const require_ = createRequire(import.meta.url)
import { alphaControlScript, ambientStyleScript, glassGuardScript, glassWindowOptions, inputHistoryScript, loadGlassSettings, saveGlassSettings, terminalScript, themeScript, whaleSprayScript, type GlassTheme } from './glass.ts'
import { gitStatus } from './git-status.ts'
import { resolveWebLaunch, waitForHttpOk, waitForReadyLine, childExited } from './launcher.ts'
import { PtyRegistry } from './pty-registry.ts'
import { repairSessionLogs } from './session-repair.ts'

const APP_ID = 'ai.deepseek.dsh-desktop'
const WINDOW_TITLE = 'DSH Desktop'
const STDERR_TAIL_LIMIT = 4_000

// GPU stability on Linux/Wayland: hardware-accelerated rendering pegs the
// renderer process (110%+ CPU) and intermittently crashes the GPU/network
// services, making the window blank or unresponsive. Software rendering
// keeps the translucent frameless window fully functional and smooth on
// every compositor. Must run before app is ready.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
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
// Glass styling state: the current Linux tint alpha and theme preference.
const userData = app.getPath('userData')
const initialGlass = loadGlassSettings(userData)
let windowAlpha = initialGlass.alpha
let windowTheme: GlassTheme = initialGlass.theme

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
 * install the self-healing tint guard (which keys off the theme attribute).
 * @param window - the window to restyle.
 */
async function applyGlass(window: BrowserWindow): Promise<void> {
  await applyGlassTheme(window, windowTheme)
  try {
    await window.webContents.executeJavaScript(glassGuardScript(windowAlpha))
  } catch {
    // Page not ready; the next did-finish-load re-applies it.
  }
}

/**
 * Inject the background-opacity slider into the hosted settings page. The
 * script mounts itself below the Appearance row (通用设置 → 外观) whenever
 * that panel renders; values travel to the main process through the preload
 * bridge. Errors are non-fatal: the next did-finish-load re-injects.
 * @param window - the window hosting the settings page.
 */
async function injectAlphaControl(window: BrowserWindow): Promise<void> {
  try {
    await window.webContents.executeJavaScript(alphaControlScript())
  } catch {
    // Settings panel not ready; the next did-finish-load re-injects.
  }
}

/**
 * Inject the ambient texture layers, floating sidebar/details cards, compact
 * new-session button, living brand (75px logo + 5s color cycling) and the
 * hero glow animation into the hosted page. Platform-independent; errors are
 * non-fatal, the next did-finish-load re-injects.
 * @param window - the window hosting the page.
 */
async function injectAmbientStyle(window: BrowserWindow): Promise<void> {
  try {
    await window.webContents.executeJavaScript(ambientStyleScript())
  } catch {
    // Page not ready; the next did-finish-load re-injects.
  }
  try {
    // Composer ⬆/⬇ input history (independent of the terminal panel).
    await window.webContents.executeJavaScript(inputHistoryScript())
  } catch {
    // Page not ready; the next did-finish-load re-injects.
  }
  try {
    // Whale-spray cursor effect over the non-message areas.
    await window.webContents.executeJavaScript(whaleSprayScript())
  } catch {
    // Page not ready; the next did-finish-load re-injects.
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
    const { readFileSync } = await import('node:fs')
    const xtermJs = readFileSync(require_.resolve('xterm/lib/xterm.js'), 'utf8')
    const xtermCss = readFileSync(require_.resolve('xterm/css/xterm.css'), 'utf8')
    // xterm UMD expects a browser global; executeJavaScript gives it one.
    await window.webContents.executeJavaScript(xtermJs)
    await window.webContents.executeJavaScript(
      '(() => { const s = document.createElement(\'style\'); s.id = \'dsh-xterm-style\'; s.textContent = ' + JSON.stringify(xtermCss) + '; document.head.appendChild(s); })()',
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
  saveGlassSettings(userData, { alpha, theme: windowTheme })
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

/** The working directory a terminal should start in (same as the server). */
function launchCwd(): string {
  return process.cwd()
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
      void injectAlphaControl(window)
      void injectAmbientStyle(window)
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

/**
 * Directory holding this package's runnable payload. In dev that is the
 * package itself; packaged, the reaper is spawned under Electron-as-Node,
 * which cannot read inside `app.asar`, so it must live in the unpacked tree.
 */
function runDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : PACKAGE_DIR
}

async function boot(): Promise<void> {
  const launch = resolveWebLaunch({ env: process.env })
  // 启动 dsh web 前自动检测并修复损坏的会话日志 (seq 缺口 / 多写流交错),
  // 否则 GUI 打开历史会话时会报 "corrupt session log: seq gap" 而失败。
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
  spawn(process.execPath, [join(runDir(), 'lib', 'reaper.js'), String(process.pid), String(child.pid ?? 0)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true,
    // Detached gives the reaper its own process group on POSIX (immune to the
    // group SIGINT that takes Electron) and a console-less independent process
    // on Windows; there taskkill /T is group-agnostic, so it still reaches the
    // reaper's targets. unref() drops the parent's handle so Electron can exit
    // without waiting — the reaper's job is to outlive it, not hold it open.
    detached: true,
  })
    // The reaper is best-effort: if it cannot start, the graceful quit path
    // still tree-kills the server; only hard-kill cleanup is lost.
    .on('error', () => {})
    // Unref after the error handler, which returns the child itself.
    .unref()
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
  // Glass IPC for the settings-page opacity slider (preload bridge). The
  // value is validated here because the renderer side is hostile surface.
  ipcMain.on('dsh:set-alpha', (_event, alpha: unknown) => {
    if (typeof alpha === 'number' && Number.isFinite(alpha)) setWindowAlpha(alpha)
  })
  ipcMain.handle('dsh:get-alpha', () => windowAlpha)
  // Embedded terminal IPC (preload bridge). The renderer side is hostile
  // surface, so inputs are size-validated and the registry bounds sessions.
  // The protocol mirrors DSH better-sidebar's terminal wire: open (attach)
  // returns the transcript for replay, input is raw text, resize is a
  // dimension pair, and close releases the pty immediately (the owning tab
  // was closed).
  ipcMain.handle('dsh:term-open', (_event, tabId: unknown, cwd: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') {
      return { error: 'invalid tab id' }
    }
    if (cwd !== undefined && cwd !== null && typeof cwd !== 'string') {
      return { error: 'invalid cwd' }
    }
    try {
      const handle = ptyRegistry.open(
        tabId,
        typeof cwd === 'string' && cwd !== '' ? cwd : launchCwd(),
      )
      // Attach the push listeners exactly once per tab: a reused handle must
      // not double-deliver output. The listeners are registered before the
      // invoke resolves, so the transcript replay in the renderer always
      // lands before the first live chunk.
      if (!attachedTermTabs.has(tabId)) {
        attachedTermTabs.add(tabId)
        handle.pty.onData((data: string) => { pushToWindow('dsh:term-data', { tabId, data }) })
        handle.pty.onExit(({ exitCode }) => { pushToWindow('dsh:term-exit', { tabId, code: exitCode }) })
      }
      return { transcript: handle.transcript, exited: handle.exited, exitCode: handle.exitCode }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.on('dsh:term-input', (_event, tabId: unknown, data: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') return
    if (typeof data !== 'string' || data.length > 16_384) return
    ptyRegistry.get(tabId)?.pty.write(data)
  })
  ipcMain.on('dsh:term-resize', (_event, tabId: unknown, cols: unknown, rows: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') return
    if (typeof cols !== 'number' || typeof rows !== 'number') return
    ptyRegistry.get(tabId)?.pty.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)))
  })
  ipcMain.on('dsh:term-close', (_event, tabId: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') return
    ptyRegistry.close(tabId)
    attachedTermTabs.delete(tabId)
  })
  // Folder browser IPC (preload bridge). Lists a directory with the same
  // shape the injected file tree expects: { cwd, path, parent, entries }.
  ipcMain.handle('dsh:fs-list', async (_event, rawPath: unknown) => {
    try {
      const { readdir, stat } = await import('node:fs/promises')
      const { resolve, dirname } = await import('node:path')
      const { homedir } = await import('node:os')
      // "~" (the Home button) expands to the user's home directory.
      const target = rawPath === '~'
        ? homedir()
        : (typeof rawPath === 'string' && rawPath.length > 0 ? resolve(rawPath) : process.cwd())
      const entries = await readdir(target, { withFileTypes: true })
      const listed = await Promise.all(entries.map(async (entry) => {
        let size: number | null = null
        if (!entry.isDirectory()) {
          try { size = (await stat(resolve(target, entry.name))).size } catch { size = null }
        }
        return { kind: entry.isDirectory() ? 'directory' : 'file', name: entry.name, path: resolve(target, entry.name), size }
      }))
      listed.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const parent = target !== dirname(target) ? dirname(target) : null
      return { cwd: process.cwd(), path: target, parent, entries: listed.slice(0, 500) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // Resolve a DSH workspace title to its directory. The file browser follows
  // the current session's workspace on project switches; the mapping lives in
  // the harness's own storage (~/.dsh/storages/workspace.json), not our
  // userData, so it stays in sync with whatever `dsh web` manages.
  ipcMain.handle('dsh:fs-workspace', async (_event, rawTitle: unknown) => {
    try {
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const { readFileSync } = await import('node:fs')
      const raw = readFileSync(join(homedir(), '.dsh', 'storages', 'workspace.json'), 'utf8')
      const data = JSON.parse(raw) as { tables?: { workspaces?: Record<string, { title?: string; path?: string }> } }
      const title = typeof rawTitle === 'string' ? rawTitle : ''
      const workspaces = data.tables?.workspaces ?? {}
      for (const ws of Object.values(workspaces)) {
        if (ws.title === title && typeof ws.path === 'string' && ws.path !== '') {
          return { path: ws.path }
        }
      }
      return { path: null }
    } catch {
      return { path: null }
    }
  })
  // /backup command: run the project backup script (mirrors
  // ~/.claude/skills/backup/SKILL.md) for the given source directory.
  ipcMain.handle('dsh:backup-run', async (_event, srcDir: unknown, args: unknown) => {
    if (typeof srcDir !== 'string' || srcDir === '') return { error: 'no source directory' }
    const argList = Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : []
    try {
      const { spawn } = await import('node:child_process')
      const { join } = await import('node:path')
      const script = join(PACKAGE_DIR, 'scripts', 'backup-project.sh')
      const child = spawn('bash', [script, srcDir, ...argList], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { out += String(d) })
      const code = await new Promise<number | null>((resolve) => { child.on('close', resolve) })
      const lines = out.trim().split('\n')
      const last = lines[lines.length - 1] ?? ''
      return {
        ok: code === 0 && last.startsWith('OK '),
        backupDir: last.startsWith('OK ') ? last.slice(3) : null,
        output: out.slice(0, 4000),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // File read IPC (preload bridge), mirroring better-sidebar's fs.read:
  // text reads carry content with a truncated flag, binary reads carry the
  // size plus a base64 head (first 4 KiB) for content sniffing. The read is
  // capped at 512 KiB like the plugin's readLimit.
  ipcMain.handle('dsh:fs-read', async (_event, rawPath: unknown) => {
    try {
      const { open, stat } = await import('node:fs/promises')
      const { resolve } = await import('node:path')
      const target = typeof rawPath === 'string' && rawPath.length > 0
        ? resolve(rawPath)
        : process.cwd()
      const readLimit = 512 * 1024
      const info = await stat(target)
      if (info.isDirectory()) return { error: `"${target}" is a directory` }
      const truncated = info.size > readLimit
      const handle = await open(target, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(info.size, readLimit))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const slice = buffer.subarray(0, bytesRead)
        const binary = slice.includes(0)
        return {
          kind: binary ? 'binary' : 'text',
          size: info.size,
          truncated,
          ...(binary
            ? { head: slice.subarray(0, Math.min(slice.length, 4096)).toString('base64') }
            : { content: slice.toString('utf8') }),
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // Git status IPC (preload bridge): the file tree's change badges. The
  // query never throws — outside a repository (or without git) it resolves
  // to { isRepo: false } and the tree renders without badges.
  ipcMain.handle('dsh:git-status', async () => {
    try {
      return await gitStatus(launchCwd())
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // Terminal state persistence IPC: the injected panel remembers each
  // project's terminal tabs (names + working directories) across launches.
  // Stored in the app's userData dir — NOT localStorage, whose origin is the
  // dsh web URL and therefore changes with every launch's random port.
  const TERM_STATE_FILE = 'terminal-state.json'
  ipcMain.handle('dsh:term-state-get', async () => {
    try {
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      return JSON.parse(readFileSync(join(userData, TERM_STATE_FILE), 'utf8'))
    } catch {
      return {}
    }
  })
  ipcMain.handle('dsh:term-state-set', async (_event, state: unknown) => {
    if (typeof state !== 'object' || state === null) {
      return { error: 'invalid terminal state' }
    }
    try {
      const { writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      writeFileSync(join(userData, TERM_STATE_FILE), JSON.stringify(state), 'utf8')
      return { ok: true }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // System clipboard for terminal copy/paste (Ctrl+Shift+C/V and Ctrl+C/V).
  // Routed through the main process because the hosted page's http origin has
  // no clipboard permission of its own.
  ipcMain.handle('dsh:clipboard-read', () => clipboard.readText())
  ipcMain.handle('dsh:clipboard-write', (_event, text: unknown) => {
    clipboard.writeText(typeof text === 'string' ? text : '')
    return true
  })
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
