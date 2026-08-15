import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const __dirname = dirname(fileURLToPath(import.meta.url))
const URL = process.env.VERIFY_URL ?? 'http://127.0.0.1:3080'
app.whenReady().then(async () => {
  ipcMain.on('dsh:set-alpha', () => {})
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadURL(URL)
  await new Promise((r) => setTimeout(r, 3000))
  const info = await win.webContents.executeJavaScript('(() => {
    const col = document.querySelector("[class*=_detailsCol]")
    const header = col ? col.querySelector("[class*=_header]") : null
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.title === "Open Terminal")
    return {
      detailsWidth: col ? Math.round(col.getBoundingClientRect().width) : null,
      detailsVisible: col ? col.getBoundingClientRect().width > 10 : false,
      headerFound: header !== null,
      termBtn: btn !== null,
      xtermLoaded: typeof window.Terminal === "function",
    }
  })()')
  console.log(JSON.stringify(info, null, 1))
  app.exit(0)
}).catch((e) => { console.error("ERR", e); app.exit(1) })
