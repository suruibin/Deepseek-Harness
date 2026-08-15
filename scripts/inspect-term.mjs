import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ambientStyleScript, terminalScript, themeScript } from '../lib/glass.js'
const __dirname = dirname(fileURLToPath(import.meta.url))
const req = createRequire(import.meta.url)
const URL = process.env.VERIFY_URL ?? 'http://127.0.0.1:3080'
app.whenReady().then(async () => {
  // 模拟主进程 PTY IPC（对齐 src/main.ts 的新协议）
  const ptyTabs = new Map()
  ipcMain.handle('dsh:term-open', (_e, tabId) => {
    try {
      const pty = req('node-pty').spawn('bash', [], { cols: 80, rows: 24 })
      ptyTabs.set(tabId, pty)
      pty.onData((d) => { win.webContents.send('dsh:term-data', { tabId, data: d }) })
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
  ipcMain.on('dsh:set-alpha', () => {})
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
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: join(__dirname, '..', 'lib', 'preload.cjs') } })
  await win.loadURL(URL)
  await new Promise((r) => setTimeout(r, 3000))
  await win.webContents.executeJavaScript(themeScript('dark'))
  await win.webContents.executeJavaScript(ambientStyleScript())
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  await win.webContents.executeJavaScript(readFileSync(req.resolve('xterm/lib/xterm.js'), 'utf8'))
  const css = readFileSync(req.resolve('xterm/css/xterm.css'), 'utf8')
  const cssInject = '(() => { const s = document.createElement("style"); s.textContent = ' + JSON.stringify(css) + '; document.head.appendChild(s); })()'
  await win.webContents.executeJavaScript(cssInject)
  await win.webContents.executeJavaScript(terminalScript())
  await new Promise((r) => setTimeout(r, 500))
  const info = await win.webContents.executeJavaScript('(() => { const btn = Array.from(document.querySelectorAll("button")).find((b) => b.title === "Terminal & Files"); const surface = document.getElementById("dsh-terminal-surface"); const tabs = surface ? Array.from(surface.querySelectorAll("button")).map((b) => b.textContent).filter(Boolean) : []; return { btnFound: btn !== null, surfaceFound: surface !== null, termLoaded: typeof window.Terminal === "function", tabs } })()')
  console.log('UI:', JSON.stringify(info))
  const diag = await win.webContents.executeJavaScript(`(() => {
    window.__dshDiagErrors = []
    window.addEventListener('error', (e) => { window.__dshDiagErrors.push(String(e.message)) })
    window.addEventListener('unhandledrejection', (e) => { window.__dshDiagErrors.push('unhandled: ' + String(e.reason)) })
    let clickErr = null
    try {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.title === 'Terminal & Files')
      if (b) b.click()
    } catch (e) { clickErr = String(e.message) }
    return { clickErr }
  })()`)
  await new Promise((r) => setTimeout(r, 800))
  const after = await win.webContents.executeJavaScript(`(() => {
    const surface = document.getElementById('dsh-terminal-surface')
    const body = surface ? surface.lastElementChild : null
    const xtermEl = surface ? surface.querySelector('.xterm') : null
    const bodyKids = body ? Array.from(body.children).map((c) => ({ id: c.id || null, display: getComputedStyle(c).display, cls: String(c.className).slice(0, 40), hasXterm: c.querySelector ? c.querySelector('.xterm') !== null : false })) : []
    return { xtermRendered: xtermEl !== null, bodyKids, errs: window.__dshDiagErrors || [] }
  })()`)
  console.log('DIAG:', JSON.stringify(diag))
  console.log('AFTER-CLICK:', JSON.stringify(after))
  for (const p of ptyTabs.values()) { try { p.kill() } catch {} }
  app.exit(0)
}).catch((e) => { console.error("ERR", e); app.exit(1) })
