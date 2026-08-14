/**
 * dsh-desktop Electron main: single-instance lock, spawn `dsh web` via the
 * launcher, wait for readiness, host the GUI in a standalone window, and keep
 * the server alive in the tray after the window closes. Closing the window
 * hides it (tray residency); quitting via the tray menu terminates the server
 * child and exits.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { killProcessTree } from './process-tree.ts'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from './electron-api.ts'
import { alphaControlScript, glassGuardScript, glassWindowOptions, loadGlassSettings, saveGlassSettings, themeScript, type GlassTheme } from './glass.ts'
import { resolveWebLaunch, waitForHttpOk, waitForReadyLine, childExited } from './launcher.ts'

const APP_ID = 'ai.deepseek.dsh-desktop'
const WINDOW_TITLE = 'DSH Desktop'
const STDERR_TAIL_LIMIT = 4_000
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
  window.once('ready-to-show', () => { window.show() })
  // The SPA's theme plugin loads asynchronously after the document finishes
  // and re-applies its own theme attribute, clobbering an eager injection.
  // Debounce the glass application until the page has settled.
  let glassTimer: NodeJS.Timeout | undefined
  const scheduleGlass = (): void => {
    if (glassTimer !== undefined) clearTimeout(glassTimer)
    glassTimer = setTimeout(() => {
      void applyGlass(window)
      void injectAlphaControl(window)
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
