import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const __dirname = dirname(fileURLToPath(import.meta.url))
const URL = process.env.VERIFY_URL ?? 'http://127.0.0.1:3080'
app.whenReady().then(async () => {
  // 模拟主进程的 PTY 与 fs IPC（对齐 src/main.ts 的新协议）
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  const ptyTabs = new Map()
  let termData = null
  ipcMain.handle('dsh:term-open', (_e, tabId, cwd) => {
    try {
      const ptyMod = req('node-pty')
      const pty = ptyMod.spawn('bash', ['-c', 'echo TERM_READY; pwd'], { cols: 80, rows: 24, cwd: typeof cwd === 'string' ? cwd : process.cwd() })
      ptyTabs.set(tabId, pty)
      pty.onData((d) => { termData = (termData || '') + d; win.webContents.send('dsh:term-data', { tabId, data: d }) })
      pty.onExit(({ exitCode }) => { win.webContents.send('dsh:term-exit', { tabId, code: exitCode }) })
      return { transcript: '', exited: false, exitCode: null }
    } catch (e) { return { error: String(e.message) } }
  })
  ipcMain.on('dsh:term-input', (_e, tabId, data) => { ptyTabs.get(tabId)?.write(data) })
  ipcMain.on('dsh:term-resize', (_e, tabId, cols, rows) => { ptyTabs.get(tabId)?.resize(cols, rows) })
  ipcMain.on('dsh:term-close', (_e, tabId) => {
    const p = ptyTabs.get(tabId)
    if (p !== undefined) { try { p.kill() } catch {} ptyTabs.delete(tabId) }
  })
  ipcMain.handle('dsh:fs-list', async (_e, p) => {
    const { readdir } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const target = typeof p === 'string' ? resolve(p) : process.cwd()
    const entries = await readdir(target, { withFileTypes: true })
    return { cwd: process.cwd(), path: target, parent: null, entries: entries.slice(0, 10).map((e) => ({ kind: e.isDirectory() ? 'directory' : 'file', name: e.name, path: resolve(target, e.name), size: null })) }
  })
  ipcMain.handle('dsh:fs-read', async (_e, p) => {
    const { readFile } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const target = typeof p === 'string' ? resolve(p) : process.cwd()
    try { return { kind: 'text', content: (await readFile(target, 'utf8')).slice(0, 512), truncated: false } }
    catch (e) { return { error: String(e.message) } }
  })
  ipcMain.handle('dsh:git-status', async () => {
    const { gitStatus } = await import('../lib/git-status.js')
    try { return await gitStatus(process.cwd()) }
    catch (e) { return { error: String(e.message) } }
  })
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: join(__dirname, '..', 'lib', 'preload.cjs') } })
  await win.loadURL(URL)
  await new Promise((r) => setTimeout(r, 3000))
  const { readFileSync } = await import('node:fs')
  await win.webContents.executeJavaScript(readFileSync(req.resolve('xterm/lib/xterm.js'), 'utf8'))
  const css = readFileSync(req.resolve('xterm/css/xterm.css'), 'utf8')
  await win.webContents.executeJavaScript('(() => { const s = document.createElement("style"); s.textContent = ' + JSON.stringify(css) + '; document.head.appendChild(s); })()')
  const { terminalScript } = await import('../lib/glass.js')
  await win.webContents.executeJavaScript(terminalScript())
  await new Promise((r) => setTimeout(r, 400))
  const ui = await win.webContents.executeJavaScript('(() => { const btn = Array.from(document.querySelectorAll("button")).find((b) => b.title === "Terminal & Files"); const surface = document.getElementById("dsh-terminal-surface"); const tabs = surface ? Array.from(surface.querySelectorAll("button")).map((b) => b.textContent).filter(Boolean) : []; return { btn: btn !== null, surface: surface !== null, tabs } })()')
  console.log('UI:', JSON.stringify(ui))
  // 打开面板（默认已在 Terminal 区，含一个自动创建的 Shell 1）
  await win.webContents.executeJavaScript('(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => x.title === "Terminal & Files"); if (b) b.click(); return true })()')
  await new Promise((r) => setTimeout(r, 800))
  const termState = await win.webContents.executeJavaScript('(() => { const surface = document.getElementById("dsh-terminal-surface"); const rows = surface ? surface.querySelector(".xterm-rows") : null; return { display: surface ? getComputedStyle(surface).display : null, xterm: rows !== null, termText: rows ? (rows.textContent || "").slice(0, 80) : null } })()')
  console.log('TERM:', JSON.stringify(termState))
  console.log('PTY output:', JSON.stringify(termData))
  // 切到文件区（树状列表）
  await win.webContents.executeJavaScript('(() => { const s = document.getElementById("dsh-terminal-surface"); const f = Array.from(s.querySelectorAll("button")).find((b) => b.textContent === "Files"); if (f) f.click(); return true })()')
  await new Promise((r) => setTimeout(r, 800))
  const filesState = await win.webContents.executeJavaScript(`(() => { const s = document.getElementById('dsh-terminal-surface'); const panel = s ? Array.from(s.querySelectorAll('div')).find((d) => d.style.overflow === 'auto' && d.style.display !== 'none') : null; const badges = panel ? Array.from(panel.querySelectorAll('span')).filter((sp) => sp.textContent === 'M' || sp.textContent === 'A' || sp.textContent === 'D' || sp.textContent === '?' ).map((sp) => sp.textContent) : []; const label = s ? s.querySelector('span') : null; return { panelFound: panel !== null, kids: panel ? panel.childElementCount : null, badges, rootLabel: label ? label.textContent : null, text: panel ? (panel.textContent || '').slice(0, 120) : null } })()`)
  console.log('FILES:', JSON.stringify(filesState))
  for (const p of ptyTabs.values()) { try { p.kill() } catch {} }
  app.exit(0)
}).catch((e) => { console.error('ERR', e); app.exit(1) })
