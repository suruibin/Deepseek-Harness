import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const __dirname = dirname(fileURLToPath(import.meta.url))
const req = createRequire(import.meta.url)
const URL = process.env.VERIFY_URL ?? 'http://127.0.0.1:3080'
app.whenReady().then(async () => {
  // 模拟真实应用的主进程 IPC
  ipcMain.handle('dsh:term-open', (_e, tabId) => {
    try {
      const pty = req('node-pty').spawn('bash', [], { cols: 80, rows: 24 })
      pty.onData((d) => { win.webContents.send('dsh:term-data', { tabId, data: d }) })
      pty.onExit(({ exitCode }) => { win.webContents.send('dsh:term-exit', { tabId, code: exitCode }) })
      return { transcript: '', exited: false, exitCode: null }
    } catch (e) { return { error: String(e.message) } }
  })
  ipcMain.on('dsh:term-input', (_e, tabId, data) => {})
  ipcMain.on('dsh:term-resize', (_e, tabId, cols, rows) => {})
  ipcMain.on('dsh:term-close', (_e, tabId) => {})
  ipcMain.handle('dsh:fs-list', async () => ({ cwd: '/tmp', path: '/tmp', parent: null, entries: [] }))
  ipcMain.handle('dsh:fs-read', async () => ({ error: 'n/a' }))
  ipcMain.handle('dsh:git-status', async () => ({ isRepo: false, entries: [] }))

  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: join(__dirname, '..', 'lib', 'preload.cjs') } })
  await win.loadURL(URL)
  // 注入前检查（正确判断）
  const before = await win.webContents.executeJavaScript(`(() => {
    const col = document.querySelector('[class*="_detailsCol"]')
    return { colFound: !!col, hasBridge: typeof window.dshDesktop !== 'undefined', hasTerm: !!(window.dshDesktop && window.dshDesktop.terminal), hasFs: !!(window.dshDesktop && window.dshDesktop.fs), hasGit: !!(window.dshDesktop && window.dshDesktop.git) }
  })()`)
  console.log('BEFORE:', JSON.stringify(before))
  // 逐步注入，每步报错
  const { readFileSync } = await import('node:fs')
  try {
    await win.webContents.executeJavaScript(readFileSync(req.resolve('xterm/lib/xterm.js'), 'utf8'))
    console.log('STEP xterm: ok')
  } catch (e) { console.log('STEP xterm FAIL:', String(e)); return app.exit(1) }
  try {
    await win.webContents.executeJavaScript('(() => { const s = document.createElement("style"); s.id = "dsh-xterm-style"; s.textContent = ' + JSON.stringify(readFileSync(req.resolve('xterm/css/xterm.css'), 'utf8')) + '; document.head.appendChild(s); })()')
    console.log('STEP css: ok')
  } catch (e) { console.log('STEP css FAIL:', String(e)); return app.exit(1) }
  const { terminalScript } = await import('../lib/glass.js')
  try {
    await win.webContents.executeJavaScript(terminalScript())
    console.log('STEP terminalScript: ok')
  } catch (e) { console.log('STEP terminalScript FAIL:', String(e)); return app.exit(1) }
  await new Promise((r) => setTimeout(r, 400))
  const after = await win.webContents.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.title === 'Terminal & Files')
    const surface = document.getElementById('dsh-terminal-surface')
    return { btnFound: !!btn, surfaceFound: !!surface }
  })()`)
  console.log('AFTER:', JSON.stringify(after))
  app.exit(0)
}).catch((e) => { console.error('ERR', e); app.exit(1) })
