#!/usr/bin/env node
/**
 * Minimal CDP client for dsh-desktop verification. One script, parameterized,
 * so verification never re-pays the WebSocket boilerplate.
 *
 * usage: node scripts/cdp.mjs <cmd> [args]
 *   eval <js>                  run JS, print result (JSON stringified)
 *   click <text>               click the leaf element whose text equals <text>
 *                              (walks up to the first BUTTON/role=button)
 *   hover <x,y>                dispatch mouseMoved to viewport coords
 *   scrollbottom               scroll the composer scroll body to the bottom
 *   vars                       print the dsh-glass-custom CSS variables
 *   shot <file> [x,y,w,h]      screenshot, optional clip (CSS px)
 *   blur-test <a.png> <b.png>  probe at (500,80): blur 100 vs 0, print diff px
 */
const [cmd, ...args] = process.argv.slice(2)

const CDP_PORT = process.env.DSH_CDP_PORT ?? '9333'
const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error(`no page target on :${CDP_PORT}`); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const reqId = ++id
  const onMsg = (e) => {
    const m = JSON.parse(e.data)
    if (m.id !== reqId) return
    ws.removeEventListener('message', onMsg)
    if (m.error) reject(new Error(m.error.message))
    else resolve(m.result)
  }
  ws.addEventListener('message', onMsg)
  ws.send(JSON.stringify({ id: reqId, method, params }))
})
const ev = (expression, awaitPromise = false) =>
  send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }).then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

ws.addEventListener('open', async () => {
  try {
    switch (cmd) {
      case 'eval': {
        const r = await ev(args.join(' '))
        console.log(typeof r === 'string' ? r : JSON.stringify(r))
        break
      }
      case 'click': {
        const text = args.join(' ')
        const hit = await ev(`(() => {
          const leaf = [...document.querySelectorAll('*')].find(e =>
            e.children.length === 0 && (e.textContent || '').trim() === ${JSON.stringify(text)})
          if (!leaf) return null
          let n = leaf
          while (n) {
            if (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button') { n.click(); return 'clicked ' + (n.className || '').toString().slice(0, 40) }
            n = n.parentElement
          }
          leaf.click(); return 'clicked leaf'
        })()`)
        console.log(hit ?? 'not found')
        break
      }
      case 'hover': {
        const [x, y] = args[0].split(',').map(Number)
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        console.log(`hovered ${x},${y}`)
        break
      }
      case 'scrollbottom': {
        await ev(`(() => { const el = document.querySelector('[class*=wSkVaW_scrollBody]'); if (el) el.scrollTop = el.scrollHeight; return el ? 'scrolled' : 'no scroll body' })()`)
        break
      }
      case 'vars': {
        const r = await ev(`(() => { const s = document.getElementById('dsh-glass-custom'); return s ? s.textContent : 'no style node' })()`)
        console.log(r)
        break
      }
      case 'shot': {
        const [file, ...rest] = args
        const clip = rest.length === 4 ? { x: Number(rest[0]), y: Number(rest[1]), width: Number(rest[2]), height: Number(rest[3]), scale: 1 } : undefined
        const { writeFileSync } = await import('node:fs')
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, clip })
        writeFileSync(file, Buffer.from(shot.data, 'base64'))
        console.log(`saved ${file}`)
        break
      }
      case 'blur-test': {
        const [aFile, bFile] = args
        const { writeFileSync } = await import('node:fs')
        await ev(`(() => { const t = document.createElement('div'); t.id = 'blur-probe'; t.style.cssText = 'position:fixed;top:80px;left:500px;width:260px;height:150px;background:rgba(39,46,62,0.45);backdrop-filter:blur(100px) saturate(140%);z-index:99999'; document.body.appendChild(t); return 1 })()`)
        await sleep(700)
        const s1 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        writeFileSync(aFile, Buffer.from(s1.data, 'base64'))
        await ev(`(() => { const t = document.getElementById('blur-probe'); t.style.backdropFilter = 'blur(0px)'; return 1 })()`)
        await sleep(700)
        const s2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        writeFileSync(bFile, Buffer.from(s2.data, 'base64'))
        await ev(`(() => { const t = document.getElementById('blur-probe'); t.remove(); return 1 })()`)
        const { execFileSync } = await import('node:child_process')
        const out = execFileSync('python3', ['-c', `
import sys, numpy as np
from PIL import Image
a = np.array(Image.open(sys.argv[1]).convert('RGB'), dtype=int)
b = np.array(Image.open(sys.argv[2]).convert('RGB'), dtype=int)
ys, xs = np.where((np.abs(a - b).sum(axis=2)) > 25)
print(len(xs))
`, aFile, bFile]).toString().trim()
        console.log(`blur diff: ${out} px`)
        break
      }
      case 'classes': {
        // Dump every CSS class currently in the page, with element count and a
        // size sample, so UI debugging never has to guess hashed class names.
        // usage: node scripts/cdp.mjs classes [filter]
        //   filter  optional substring — only classes containing it are printed
        const filter = args.join(' ').trim()
        const cond = filter === '' ? `true` : `c.includes(${JSON.stringify(filter)})`
        const expr = `(() => {
          const counts = new Map()
          const widths = new Map()
          for (const el of document.querySelectorAll('*')) {
            const cls = el.className && typeof el.className === 'string' ? el.className.split(/\\s+/) : []
            for (const c of cls) {
              if (!c) continue
              counts.set(c, (counts.get(c) || 0) + 1)
              if (!widths.has(c)) widths.set(c, Math.round(el.getBoundingClientRect().width))
            }
          }
          const rows = [...counts.entries()]
            .filter(([c]) => CONDITION)
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => c + '\\t' + n + '\\t' + widths.get(c))
          return rows.join('\\n')
        })()`.replace('CONDITION', cond)
        const r = await ev(expr)
        console.log(r)
        break
      }
      default:
        console.error(`unknown cmd: ${cmd}`)
        process.exit(1)
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`)
    process.exit(1)
  } finally {
    ws.close()
  }
})
