/**
 * dsh-desktop misc injected renderer scripts: whale-spray cursor, composer
 * input history, desktop-shell feature toggles, interface-glass controls
 * panel, and the theme-settings nav integration.
 *
 * Each export returns a JS string executed in the hosted page via inject()
 * in main.ts. Self-contained: no imports, no shared module state.
 */
/**
 * Whale-spray cursor effect: while the pointer moves across the center
 * column's non-message areas (header, input bar, margins — anything outside
 * the message scroll body), a little whale follows the cursor and spouts a
 * fountain of water from its blowhole. The whale is hand-drawn on a
 * full-window canvas overlay (pointer-events: none, so it never intercepts
 * clicks), faces the direction of travel, and its body color follows the
 * current whale brand color. Droplets arc under gravity and fade out; the
 * animation loop only runs while the whale is visible.
 */
/**
 * Cursor particle effect: over the center column's non-message areas the
 * pointer spouts a small fountain of water droplets (colored by the current
 * whale brand color); over the sidebar it scatters random-hue twinkling
 * stars. Both are lightweight canvas particles with no body drawing, so the
 * animation stays smooth even under software rendering.
 */
/**
 * Cursor particle effect, driven by the settings toggle (通用设置 → 外观 →
 * 光标特效). Modes: mixed (stars over the sidebar, water over the center),
 * water, star, snow (falling flakes) and spark (rising embers). Lightweight
 * canvas particles only — no body drawing — so it stays smooth even under
 * software rendering. Reads its config from localStorage
 * (dsh-desktop-cursor-fx) and reconfigures live on the
 * dsh-cursor-fx-change event dispatched by the settings control.
 */
export function whaleSprayScript(): string {
  return `(() => {
    if (window.__dshWhaleSpray) {
      window.__dshWhaleSpray.dispose()
      window.__dshWhaleSpray = undefined
    }
    // ── Config from the settings toggle (default: stars over the sidebar,
    // water over the center; migrate the old single-mode config if present) ──
    let cfg = { enabled: true, sidebar: 'star', center: 'water' }
    try {
      const raw = localStorage.getItem('dsh-desktop-cursor-fx')
      if (raw !== null) {
        const parsed = JSON.parse(raw)
        if (typeof parsed.mode === 'string' && typeof parsed.sidebar !== 'string') {
          cfg = { enabled: parsed.enabled !== false, sidebar: parsed.mode === 'mixed' ? 'star' : parsed.mode, center: parsed.mode === 'mixed' ? 'water' : parsed.mode }
        } else {
          cfg = Object.assign(cfg, parsed)
        }
      }
    } catch {}
    if (cfg.enabled === false) return // toggle off: no canvas at all

    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147482999'
    document.body.appendChild(canvas)
    const ctx = canvas.getContext('2d')
    if (ctx === null) { canvas.remove(); return }
    const resize = () => {
      canvas.width = innerWidth * devicePixelRatio
      canvas.height = innerHeight * devicePixelRatio
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    }
    resize()
    addEventListener('resize', resize)

    // Whale palette mirrors the ambient brand cycle.
    const WHALES = ['#4176e6', '#3b82f6', '#06b6d4', '#10b981', '#6366f1', '#0ea5e9', '#7b5cf0', '#f472b6']
    const whaleColor = () => {
      // rc.8: the icon svg has no rect anymore; the wordmark svg carries
      // white/currentColor decoration rects that would read as a wrong color.
      // Read the icon's first gradient stop instead, falling back to a random
      // whale color while the brand is still initializing.
      const grad = document.querySelector('[class*="_brand"] svg linearGradient[id="dsh-logo-grad"]')
      if (grad !== null && grad.firstChild !== null) {
        const c = grad.firstChild.getAttribute('stop-color')
        if (c !== null) return c
      }
      return WHALES[Math.floor(Math.random() * WHALES.length)]
    }

    const triggerZone = (x, y) => {
      // The desktop file-browser sidebar (主题设置 → 桌面功能 → 侧边栏) floats
      // over the page as a fixed right-hand panel, OUTSIDE the DSH column
      // layout — treat it as part of the center pane so the cursor effect
      // applies there too, using the center (右侧) mode. Its file rows are not
      // chat messages, so the composer/message exclusions below are skipped.
      const filesPanel = document.getElementById('dsh-files-panel')
      if (filesPanel !== null && filesPanel.style.display !== 'none') {
        const fr = filesPanel.getBoundingClientRect()
        if (x >= fr.left && x <= fr.right && y >= fr.top && y <= fr.bottom) return 'center'
      }
      // 'sidebar' or 'center' when the point is a trigger area, else null.
      const sidebar = document.querySelector('[class*="_sidebarCol"]')
      const center = document.querySelector('[class*="_centerCol"]')
      let zone = null
      for (const [cls, name] of [[sidebar, 'sidebar'], [center, 'center']]) {
        if (cls === null) continue
        const r = cls.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { zone = name; break }
      }
      if (zone === null) return null
      // Never over the composer input area itself.
      const seat = document.querySelector('[class*="_composerSeat"]')
      if (seat !== null) {
        const sr = seat.getBoundingClientRect()
        if (x >= sr.left && x <= sr.right && y >= sr.top && y <= sr.bottom) return null
      }
      // Skip actual message rows inside the scroll body.
      const under = document.elementFromPoint(x, y)
      if (under !== null) {
        for (let el = under; el !== null && el !== document.body; el = el.parentElement) {
          const c = String(el.className)
          if (/message|_turn|_row|_bubble|_msg|_item|markdown|_content/i.test(c) && el.closest('[class*="_scrollBody"]') !== null) {
            return null
          }
        }
      }
      return zone
    }

    // Particles: kind 'drop' (water), 'star', 'snow', 'spark'.
    const drops = []
    const MAX_DROPS = 80
    const pushDrop = (d) => {
      if (drops.length >= MAX_DROPS) drops.shift()
      drops.push(d)
    }
    const spawnWater = (x, y, color) => {
      for (let i = 0; i < 3; i++) {
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 0.4
        const speed = 3 + Math.random() * 2
        pushDrop({ kind: 'drop', x: x + (Math.random() - 0.5) * 3, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, life: 0, ttl: 420 + Math.random() * 180, size: 1.2 + Math.random(), color })
      }
      for (let i = 0; i < 2; i++) {
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.4
        const speed = 1.4 + Math.random() * 1.6
        pushDrop({ kind: 'drop', x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, life: 0, ttl: 460 + Math.random() * 180, size: 0.9 + Math.random() * 0.8, color })
      }
    }
    const spawnStars = (x, y) => {
      const hue = Math.floor(Math.random() * 360)
      const color = 'hsl(' + hue + ', 90%, 68%)'
      for (let i = 0; i < 2; i++) {
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.2
        const speed = 0.7 + Math.random() * 1.2
        pushDrop({ kind: 'star', x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 6, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, life: 0, ttl: 700 + Math.random() * 300, size: 3 + Math.random() * 2.5, color, rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.06 })
      }
    }
    const spawnSnow = (x, y) => {
      const color = 'rgba(255,255,255,' + (0.7 + Math.random() * 0.3).toFixed(2) + ')'
      for (let i = 0; i < 2; i++) {
        pushDrop({ kind: 'snow', x: x + (Math.random() - 0.5) * 20, y: y + (Math.random() - 0.5) * 10, vx: (Math.random() - 0.5) * 0.4, vy: 0.4 + Math.random() * 0.6, life: 0, ttl: 900 + Math.random() * 500, size: 2.5 + Math.random() * 2, color, rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.05 })
      }
    }
    const spawnSpark = (x, y) => {
      const hue = Math.floor(Math.random() * 60) // warm
      const color = 'hsl(' + hue + ', 95%, 62%)'
      for (let i = 0; i < 3; i++) {
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.8
        const speed = 1.5 + Math.random() * 2.5
        pushDrop({ kind: 'spark', x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, life: 0, ttl: 380 + Math.random() * 240, size: 1 + Math.random() * 1.4, color })
      }
    }
    const drawStar = (d) => {
      const spikes = 5
      const outer = d.size
      const inner = outer * 0.4
      ctx.beginPath()
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outer : inner
        const a = d.rot + (i * Math.PI) / spikes - Math.PI / 2
        const px = d.x + Math.cos(a) * r
        const py = d.y + Math.sin(a) * r
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fill()
    }
    const drawSnow = (d) => {
      // Six-arm flake: three crossing lines.
      ctx.strokeStyle = d.color
      ctx.lineWidth = 1
      ctx.lineCap = 'round'
      for (let arm = 0; arm < 3; arm++) {
        const a = d.rot + (arm * Math.PI) / 3
        ctx.beginPath()
        ctx.moveTo(d.x - Math.cos(a) * d.size, d.y - Math.sin(a) * d.size)
        ctx.lineTo(d.x + Math.cos(a) * d.size, d.y + Math.sin(a) * d.size)
        ctx.stroke()
      }
    }
    const drawSpark = (d) => {
      ctx.strokeStyle = d.color
      ctx.lineWidth = 1.2
      ctx.lineCap = 'round'
      const a = Math.atan2(d.vy, d.vx)
      const len = d.size * 3
      ctx.beginPath()
      ctx.moveTo(d.x - Math.cos(a) * len, d.y - Math.sin(a) * len)
      ctx.lineTo(d.x, d.y)
      ctx.stroke()
    }

    const kindForZone = (zone) => zone === 'sidebar' ? cfg.sidebar : cfg.center

    let raf = 0
    let running = false
    let lastT = 0
    const tick = (now) => {
      const dt = Math.min(32, now - (lastT || now))
      lastT = now
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i]
        d.life += dt
        if (d.life >= d.ttl) { drops.splice(i, 1); continue }
        if (d.kind === 'snow') {
          d.x += d.vx * (dt / 16) + Math.sin((d.life + d.rot * 100) / 300) * 0.15
          d.y += d.vy * (dt / 16)
          d.rot += d.vr * (dt / 16)
        } else if (d.kind === 'star') {
          d.vy -= 0.008 * (dt / 16)
          d.rot += d.vr * (dt / 16)
          d.x += d.vx * (dt / 16)
          d.y += d.vy * (dt / 16)
        } else if (d.kind === 'spark') {
          d.vy += 0.06 * (dt / 16)
          d.x += d.vx * (dt / 16)
          d.y += d.vy * (dt / 16)
        } else {
          d.vy += 0.12 * (dt / 16)
          d.x += d.vx * (dt / 16)
          d.y += d.vy * (dt / 16)
        }
      }
      ctx.clearRect(0, 0, innerWidth, innerHeight)
      for (const d of drops) {
        const k = 1 - d.life / d.ttl
        ctx.globalAlpha = Math.max(0, Math.min(1, k * 1.2))
        ctx.fillStyle = d.color
        if (d.kind === 'star') drawStar(d)
        else if (d.kind === 'snow') drawSnow(d)
        else if (d.kind === 'spark') drawSpark(d)
        else {
          ctx.beginPath()
          ctx.arc(d.x, d.y, d.size * (0.5 + 0.5 * k), 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.globalAlpha = 1
      if (drops.length > 0) {
        raf = requestAnimationFrame(tick)
      } else {
        running = false
        ctx.clearRect(0, 0, innerWidth, innerHeight)
      }
    }
    let lastX = -1
    let lastY = -1
    const onMove = (e) => {
      const x = e.clientX
      const y = e.clientY
      const zone = triggerZone(x, y)
      if (zone === null) return
      // Throttle: one burst per 40px of travel.
      if (Math.abs(x - lastX) + Math.abs(y - lastY) < 40) return
      lastX = x
      lastY = y
      const kind = kindForZone(zone)
      if (kind === 'none') return // that pane's effect is off
      const color = whaleColor()
      if (kind === 'star') spawnStars(x, y)
      else if (kind === 'snow') spawnSnow(x, y)
      else if (kind === 'spark') spawnSpark(x, y)
      else spawnWater(x, y, color)
      if (!running) {
        running = true
        lastT = performance.now()
        raf = requestAnimationFrame(tick)
      }
    }
    const onMovePaused = (e) => { if (!paused) onMove(e) }
    addEventListener('mousemove', onMovePaused)

    // Live reconfiguration from the settings toggle. Disabling pauses the
    // effect in place (canvas stays mounted, listeners stay registered) so
    // re-enabling works instantly without a page reload; a full reload still
    // re-runs this script from the persisted config.
    let paused = false
    const onFxChange = (e) => {
      const detail = e.detail
      if (!detail || typeof detail.enabled !== 'boolean') return
      if (detail.enabled === false) {
        paused = true
        drops.length = 0
        cancelAnimationFrame(raf)
        running = false
        ctx.clearRect(0, 0, innerWidth, innerHeight)
        return
      }
      paused = false
      if (typeof detail.sidebar === 'string') cfg.sidebar = detail.sidebar
      if (typeof detail.center === 'string') cfg.center = detail.center
      drops.length = 0
    }
    addEventListener('dsh-cursor-fx-change', onFxChange)

    const dispose = () => {
      removeEventListener('mousemove', onMovePaused)
      removeEventListener('resize', resize)
      removeEventListener('dsh-cursor-fx-change', onFxChange)
      cancelAnimationFrame(raf)
      canvas.remove()
      window.__dshWhaleSpray = undefined
    }
    window.__dshWhaleSpray = { dispose }
  })()`
}






/**
 * Injected UI for the embedded terminal + folder browser: a bottom terminal
 * dock and a right-side file panel, toggled by two fixed buttons in the
 * window's top-right corner. Both are page-level fixed overlays so they work
 * regardless of the DSH layout state (the details column is collapsible to
 * width 0). The terminal dock holds multi-tab PTY sessions
 * (`src/pty-registry.ts`) mirroring DSH better-sidebar semantics: attach
 * replays the bounded transcript, live output streams per tab, closing a tab
 * releases its process, exited tabs show the code and respawn on re-attach,
 * and a per-window cap bounds concurrent shells. The file panel is an
 * expandable directory tree with text/binary preview and git change badges.
 * Font family/size persist to localStorage; the xterm theme follows the
 * page's dark/light tokens and re-themes in place.
 */

/**
 * Injected UI for the embedded terminal + folder browser: a full-width
 * bottom terminal dock (the app squeezes up by the dock height so the
 * message input stays visible above it) and a right-side file panel that
 * squeezes the app horizontally (the conversation is never hidden). Both are
 * page-level fixed overlays, independent of the DSH layout state (the
 * details column is collapsible to width 0). The terminal toggle sits at the
 * window's bottom edge and hides while the dock is open (the dock has its
 * own collapse button). The file panel is a navigable file browser — enter
 * directories, back/forward/up history, drag the left edge to resize, click
 * a file to preview — with git change badges. Terminal tabs map 1:1 to
 * main-process PTY sessions (`src/pty-registry.ts`) mirroring DSH
 * better-sidebar semantics: attach replays the bounded transcript, live
 * output streams per tab, closing a tab releases its process, exited tabs
 * show the code and respawn on re-attach, per-window cap. Font family/size
 * persist to localStorage; the xterm theme follows the page's dark/light
 * tokens and re-themes in place.
 */

/**
 * Composer input history: ArrowUp / ArrowDown inside the message input recall
 * previously sent prompts (shell-style). History is global (not per session),
 * persisted to localStorage, capped at 50 entries. Enter (no modifier) saves
 * the current text; the React-controlled textarea is written through its
 * native value setter plus an input event so the SPA's state stays in sync.
 */
export function inputHistoryScript(): string {
  return `(() => {
    const KEY = 'dsh-desktop-input-history'
    const MAX = 50
    let history = []
    try {
      const raw = localStorage.getItem(KEY)
      if (raw !== null) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) history = parsed.filter((x) => typeof x === 'string')
      }
    } catch {}
    let idx = -1
    let draft = ''
    const findInput = () => Array.from(document.querySelectorAll('textarea')).find(
      (t) => !t.classList.contains('xterm-helper-textarea') && (t.placeholder || '').trim() !== '',
    )
    const setValue = (input, value) => {
      // React controlled component: native setter + input event keeps React's
      // internal value tracker in sync (assigning input.value alone is ignored).
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      try { input.setSelectionRange(value.length, value.length) } catch {}
    }
    const onKey = (e) => {
      if (e.key === 'ArrowUp') {
        if (history.length === 0) return
        e.preventDefault()
        // Recall from the NEWEST entry backwards (shell-style).
        if (idx === -1) { draft = e.target.value; idx = history.length }
        idx = Math.max(0, idx - 1)
        setValue(e.target, history[idx])
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        idx = Math.min(history.length, idx + 1)
        setValue(e.target, idx >= history.length ? draft : history[idx])
      } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const text = e.target.value.trim()
        // /backup: intercept as a command — back up the CURRENT session's
        // workspace directory instead of sending the text to the model.
        if (text === '/backup' || text.startsWith('/backup ')) {
          e.preventDefault()
          e.stopPropagation()
          runBackup(e.target, text)
          return
        }
        if (text !== '' && history[history.length - 1] !== text) {
          history.push(text)
          if (history.length > MAX) history = history.slice(-MAX)
          try { localStorage.setItem(KEY, JSON.stringify(history)) } catch {}
        }
        idx = -1
      }
    }
    // The sidebar groups sessions under workspace headers; the header of the
    // group containing the selected row is the workspace title.
    const workspaceName = () => {
      const sel = document.querySelector('[class*="YDXeBa_selected"], [aria-selected="true"]')
      if (sel === null) return null
      let node = sel
      for (let i = 0; i < 8 && node !== null; i++) {
        if ((node.className || '').toString().includes('groupSection')) {
          const first = node.firstElementChild
          const t = first !== null ? (first.textContent || '').trim() : ''
          return t !== '' ? t : null
        }
        node = node.parentElement
      }
      return null
    }
    const toast = (msg) => {
      let el = document.getElementById('dsh-backup-toast')
      if (el === null) {
        el = document.createElement('div')
        el.id = 'dsh-backup-toast'
        el.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483647;background:rgba(20,24,34,0.96);color:#fff;font-size:13px;line-height:1.5;padding:10px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.45);max-width:440px;white-space:pre-wrap;word-break:break-all;display:none'
        document.body.appendChild(el)
      }
      el.textContent = msg
      el.style.display = 'block'
      clearTimeout(el._t)
      el._t = setTimeout(() => { el.style.display = 'none' }, 10000)
    }
    const runBackup = (input, text) => {
      const args = text.split(/\s+/).slice(1)
      const ws = workspaceName()
      const fail = (m) => toast('备份失败: ' + m)
      if (ws === null) { fail('无法确定当前工作区'); return }
      if (typeof window.dshDesktop === 'undefined' || !window.dshDesktop.fs || !window.dshDesktop.backup) { fail('桥接不可用'); return }
      window.dshDesktop.fs.workspace(ws).then((r) => {
        if (r && typeof r.path === 'string' && r.path !== '') {
          toast('正在备份 ' + r.path + ' …')
          window.dshDesktop.backup.run(r.path, args).then((res) => {
            if (res && res.ok && typeof res.backupDir === 'string') {
              toast('备份完成 ✓\\n' + res.backupDir)
              // Clear the command from the input.
              setValue(input, '')
            } else if (res && res.error) {
              fail(String(res.error))
            } else {
              fail((res && res.output ? String(res.output).trim().slice(0, 300) : '未知错误'))
            }
          }).catch((err) => { fail(String(err)) })
        } else {
          fail('无法解析工作区路径')
        }
      }).catch((err) => { fail(String(err)) })
    }
    const attach = () => {
      const input = findInput()
      if (input !== null && input.dataset.dshHistory === undefined) {
        input.dataset.dshHistory = '1'
        input.addEventListener('keydown', onKey)
      }
    }
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => { pending = false; attach() })
    }
    const obs = new MutationObserver(schedule)
    obs.observe(document.body, { childList: true, subtree: true })
    attach()
    window.__dshInputHistory = {
      dispose: () => {
        obs.disconnect()
        const input = findInput()
        if (input !== null) input.removeEventListener('keydown', onKey)
      },
    }
  })()`
}
/**
 * Injected UI for the desktop-shell feature toggles in the Theme Settings
 * panel (主题设置): whether the file browser panel and the terminal dock are
 * enabled, and how often the top-left brand (wordmark + whale icon) changes
 * color. Choices persist in localStorage (same pattern as the cursor-fx
 * config) and take effect immediately by dispatching window events that the
 * terminal/brand scripts listen to:
 *   - dsh-files-visible-change   { visible }   → terminalScript
 *   - dsh-terminal-visible-change{ visible }   → terminalScript
 *   - dsh-brand-cycle-change     { intervalMs }→ ambientStyleScript
 */
export function featureControlScript(): string {
  return `(() => {
    if (window.__dshFeatureControlObserver) {
      window.__dshFeatureControlObserver.disconnect()
      window.__dshFeatureControlObserver = undefined
    }
    const KEYS = {
      files: 'dsh-desktop-files-visible',
      term: 'dsh-desktop-terminal-visible',
      cycle: 'dsh-desktop-brand-cycle-sec',
    }
    const read = (key, fallback) => {
      try {
        const raw = localStorage.getItem(key)
        if (raw !== null) return JSON.parse(raw)
      } catch {}
      return fallback
    }
    const write = (key, value) => {
      try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
    }
    const mount = () => {
      if (window.dshDesktop === undefined) return
      // Mount inside the Theme Settings panel (主题设置), like the alpha and
      // wallpaper controls.
      const panel = document.querySelector('[data-dsh-theme-panel]')
      if (panel === null) return
      const zh = window.__dshThemeLocale !== 'en'
      const labels = {
        title: zh ? '桌面功能' : 'Desktop features',
        files: zh ? '侧边栏' : 'Sidebar',
        term: zh ? '显示终端' : 'Show terminal',
        cycle: zh ? '颜色切换时间' : 'Brand color interval',
        unit: zh ? '秒' : 's',
      }
      // ── Cycle interval control (own block, ABOVE the opacity slider) ──
      let cycleControl = document.querySelector('[data-dsh-cycle-control]')
      if (cycleControl === null) {
        const holder = panel.querySelector('[data-dsh-theme-cycle-slot]') || panel
        cycleControl = document.createElement('div')
        cycleControl.dataset.dshCycleControl = 'true'
        cycleControl.style.cssText = 'display:flex;align-items:center;gap:10px;padding:16px 0;width:100%'
        cycleControl.innerHTML =
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px" data-dsh-label-cycle></span>' +
          '<div style="display:flex;align-items:center;gap:6px;margin-left:auto">' +
            '<input type="number" min="1" max="600" step="1" data-dsh-cycle-input style="width:64px;background:rgb(39,46,62);color:var(--dsw-alias-label-primary);border:none;border-radius:10px;padding:6px 8px;font-size:13px;text-align:center;outline:none">' +
            '<span style="color:var(--dsw-alias-label-secondary);font-size:12px;min-width:16px" data-dsh-cycle-unit></span>' +
          '</div>'
        const sync = (sel, text) => {
          const el = cycleControl.querySelector(sel)
          if (el !== null) el.textContent = text
        }
        sync('[data-dsh-label-cycle]', labels.cycle)
        sync('[data-dsh-cycle-unit]', labels.unit)
        const cycleInput = cycleControl.querySelector('[data-dsh-cycle-input]')
        if (cycleInput !== null) {
          cycleInput.value = String(Math.max(1, Math.min(600, Math.round(read(KEYS.cycle, 10)))))
          cycleInput.addEventListener('change', () => {
            let secs = Math.round(Number(cycleInput.value))
            if (!Number.isFinite(secs)) secs = 10
            secs = Math.max(1, Math.min(600, secs))
            cycleInput.value = String(secs)
            write(KEYS.cycle, secs)
            window.dispatchEvent(new CustomEvent('dsh-brand-cycle-change', { detail: { intervalMs: secs * 1000 } }))
          })
        }
        holder.appendChild(cycleControl)
      } else {
        // Locale sync in place (the SPA swaps text without rebuilding).
        const sync = (sel, text) => {
          const el = cycleControl.querySelector(sel)
          if (el !== null && el.textContent !== text) el.textContent = text
        }
        sync('[data-dsh-label-cycle]', labels.cycle)
        sync('[data-dsh-cycle-unit]', labels.unit)
      }
      // ── Panel visibility toggles (own block, below the alpha control) ──
      const MOUNTED = '[data-dsh-feature-controls]'
      const existing = document.querySelector(MOUNTED)
      if (existing !== null) {
        const sync = (sel, text) => {
          const el = existing.querySelector(sel)
          if (el !== null && el.textContent !== text) el.textContent = text
        }
        sync('[data-dsh-feature-title]', labels.title)
        sync('[data-dsh-label-files]', labels.files)
        sync('[data-dsh-label-term]', labels.term)
        return
      }
      const control = document.createElement('div')
      control.dataset.dshFeatureControls = 'true'
      control.style.cssText = 'flex-direction:column;gap:12px;padding:16px 0;display:flex'
      control.innerHTML =
        '<div style="color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px" data-dsh-feature-title></div>' +
        // Toggle switches (36×20 track, 16px thumb) styled like the theme.
        '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding-left:12px">' +
          '<span class="dsh-switch">' +
            '<input type="checkbox" data-dsh-toggle-files>' +
            '<span class="track"></span><span class="thumb"></span>' +
          '</span>' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px" data-dsh-label-files></span>' +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding-left:12px">' +
          '<span class="dsh-switch">' +
            '<input type="checkbox" data-dsh-toggle-term>' +
            '<span class="track"></span><span class="thumb"></span>' +
          '</span>' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px" data-dsh-label-term></span>' +
        '</label>' +
        '<style>' +
          '[data-dsh-feature-controls] .dsh-switch { position:relative; width:36px; height:20px; flex:none; }' +
          '[data-dsh-feature-controls] .dsh-switch input { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; z-index:1; }' +
          '[data-dsh-feature-controls] .dsh-switch .track { position:absolute; inset:0; border-radius:999px; background:rgba(128,132,142,0.35); box-shadow:inset 0 0 0 1px rgba(255,255,255,0.08); transition:background 0.15s ease; }' +
          '[data-dsh-feature-controls] .dsh-switch .thumb { position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.35); transition:transform 0.15s ease; }' +
          '[data-dsh-feature-controls] .dsh-switch input:checked ~ .track { background:#4176e6; }' +
          '[data-dsh-feature-controls] .dsh-switch input:checked ~ .thumb { transform:translateX(16px); }' +
        '</style>'
      const titleEl = control.querySelector('[data-dsh-feature-title]')
      if (titleEl !== null) titleEl.textContent = labels.title
      const filesToggle = control.querySelector('[data-dsh-toggle-files]')
      const termToggle = control.querySelector('[data-dsh-toggle-term]')
      if (filesToggle === null || termToggle === null) return
      const sync = (sel, text) => {
        const el = control.querySelector(sel)
        if (el !== null) el.textContent = text
      }
      sync('[data-dsh-label-files]', labels.files)
      sync('[data-dsh-label-term]', labels.term)
      // Initial state from persisted settings (defaults: both panels on).
      filesToggle.checked = read(KEYS.files, true) !== false
      termToggle.checked = read(KEYS.term, true) !== false
      filesToggle.addEventListener('change', () => {
        const visible = filesToggle.checked
        write(KEYS.files, visible)
        window.dispatchEvent(new CustomEvent('dsh-files-visible-change', { detail: { visible } }))
      })
      termToggle.addEventListener('change', () => {
        const visible = termToggle.checked
        write(KEYS.term, visible)
        window.dispatchEvent(new CustomEvent('dsh-terminal-visible-change', { detail: { visible } }))
      })
      // Mount inside the Theme Settings panel's dedicated feature slot.
      const holder = panel.querySelector('[data-dsh-theme-feature-slot]') || panel
      holder.appendChild(control)
    }
    mount()
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => { pending = false; mount() })
    }
    const obs = new MutationObserver(schedule)
    window.__dshFeatureControlObserver = obs
    // childList: row (re)mounts; characterData: locale switches swap text in
    // place, which must re-sync the mounted controls' labels.
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
  })()`
}

/**
 * Injected UI for the unified frosted-glass controls in the Theme Settings
 * panel (主题设置 → 界面毛玻璃): five independent sliders — MAIN surface
 * (composer card, task strip, user bubbles), SETTINGS surface (the hosted
 * settings panel itself), INPUT (the composer card), SIDEBAR, and POPUP
 * (dropdown menus, e.g. _3e4SsG_menu / _7KE1Ra_menu / _sideTop_ / the
 * queued-message dock _7yHdaG_dock). Each writes
 * a single pair of CSS variables consumed by the ambientStyleScript rules, so
 * one slider re-themes every surface of that family at once instead of
 * configuring them one by one. Values persist to localStorage (percent,
 * defaults: main/settings 35, input/sidebar 100, popup 7) and apply
 * immediately via the `#dsh-glass-custom` style node.
 */
export function glassControlsScript(): string {
  return `(() => {
    if (window.__dshGlassControlObserver) {
      window.__dshGlassControlObserver.disconnect()
      window.__dshGlassControlObserver = undefined
    }
    const read = (key, fallback) => {
      try {
        const raw = localStorage.getItem(key)
        if (raw !== null) {
          const v = Number(raw)
          if (Number.isFinite(v)) return v
        }
      } catch {}
      return fallback
    }
    const write = (key, value) => {
      try { localStorage.setItem(key, String(value)) } catch {}
    }
    // One slider per surface. The popup and input card ride the blue-gray
    // rgba(39,46,62) tone; the input defaults to the opaque look the user
    // asked for. mainblur is the big-surface frosted strength (px), shared by
    // main/settings/sidebar/input; popupblur is the popup family's own.
    const SLIDERS = [
      { key: 'mainblur', min: 0, max: 100, def: 20, unit: 'px' },
      { key: 'popupblur', min: 0, max: 100, def: 20, unit: 'px' },
      { key: 'main', min: 0, max: 100, def: 0, unit: '%' },
      { key: 'settings', min: 0, max: 100, def: 5, unit: '%' },
      { key: 'input', min: 0, max: 100, def: 30, unit: '%' },
      { key: 'sidebar', min: 0, max: 100, def: 5, unit: '%' },
      { key: 'popup', min: 5, max: 100, def: 7, unit: '%' },
      // Global saturation of the whole window (body filter: saturate). 100% =
      // no change; applied only when != 100 so the default leaves no
      // containing-block side effect on fixed-position elements.
      { key: 'saturate', min: 100, max: 150, def: 100, unit: '%' },
    ]
    const values = Object.fromEntries(SLIDERS.map((s) =>
      [s.key, Math.max(s.min, Math.min(s.max, read('dsh-desktop-glass-' + s.key, s.def)))]))
    // One style node carries the glass variables; ambientStyleScript's
    // rules reference them with the same values as defaults, so this node only
    // matters once the user deviates from the default.
    const applyVars = () => {
      let s = document.getElementById('dsh-glass-custom')
      if (s === null) {
        s = document.createElement('style')
        s.id = 'dsh-glass-custom'
        document.head.appendChild(s)
      }
      const a = (v) => 'rgba(15,17,23,' + (v / 100).toFixed(3) + ')'
      const b = (v) => 'rgba(39,46,62,' + (v / 100).toFixed(3) + ')'
      // The sidebar follows its own 侧边栏 slider exactly — NO wallpaper floor —
      // so at the same slider value it renders identically to the 对话/轨迹 header
      // card, which shares the same --dsh-glass-sidebar-bg variable. The old
      // 12% floor over a wallpaper made the sidebar read ~10 levels darker than
      // the header card and shifted it off the wallpaper (user: 跟顶部的一样).
      const sidebarBg = a(values.sidebar)
      // Global saturation: applied to body only when != 100 (saturate(100%)
      // still creates a containing block for fixed children, so the default
      // must leave body filter-free to avoid shifting fixed overlays/docks).
      // A body filter makes fixed children position against body instead of
      // the viewport; pinning html/body to the viewport and hiding their
      // scrollbars keeps those fixed overlays in place and suppresses the
      // outer horizontal/vertical scrollbars on the window edge.
      const satActive = values.saturate !== 100
      // overflow:hidden needs !important: the hosted SPA sets its own
      // overflow on html/body and would otherwise win over this rule.
      const satRule = satActive ? ('filter: saturate(' + values.saturate + '%); height: 100%; overflow: hidden !important; ') : ''
      const satHtml = satActive ? 'html { height: 100%; overflow: hidden !important; } ' : ''
      // Hardware GL (use-angle=gl, see main.ts) renders full-window
      // backdrop-filters cheaply (~20% GPU process vs 660% under SwiftShader),
      // so the big panes get real frosted blur again, driven by mainblur.
      s.textContent = satHtml + 'body { ' +
        '--dsh-glass-main-bg: ' + a(values.main) + '; ' +
        '--dsh-glass-main-blur: ' + values.mainblur + 'px; ' +
        '--dsh-glass-settings-bg: ' + a(values.settings) + '; ' +
        '--dsh-glass-settings-blur: ' + values.mainblur + 'px; ' +
        '--dsh-glass-input-bg: ' + b(values.input) + '; ' +
        '--dsh-glass-sidebar-bg: ' + sidebarBg + '; ' +
        '--dsh-glass-popup-bg: ' + b(values.popup) + '; ' +
        '--dsh-glass-popup-blur: ' + values.popupblur + 'px; ' +
        satRule +
      '}'
    }
    const mount = () => {
      if (window.dshDesktop === undefined) return
      const panel = document.querySelector('[data-dsh-theme-panel]')
      if (panel === null) return
      const zh = window.__dshThemeLocale !== 'en'
      const labels = {
        title: zh ? '界面毛玻璃' : 'Interface glass',
        groupBlur: zh ? '界面模糊' : 'Surface blur',
        groupAlpha: zh ? '界面透明度' : 'Surface opacity',
        main: zh ? '主界面' : 'Main surface',
        settings: zh ? '设置界面' : 'Settings surface',
        input: zh ? '输入框' : 'Input surface',
        sidebar: zh ? '侧边栏' : 'Sidebar',
        mainblur: zh ? '界面模糊' : 'Surface blur',
        popup: zh ? '弹出层' : 'Popup menus',
        popupblur: zh ? '弹窗模糊' : 'Popup blur',
        saturate: zh ? '整体饱和度' : 'Saturation',
      }
      const existing = document.querySelector('[data-dsh-glass-controls]')
      if (existing !== null) {
        const sync = (sel, text) => {
          const el = existing.querySelector(sel)
          if (el !== null && el.textContent !== text) el.textContent = text
        }
        sync('[data-dsh-glass-group-blur]', labels.groupBlur)
        sync('[data-dsh-glass-group-alpha]', labels.groupAlpha)
        for (const s of SLIDERS) sync('[data-dsh-glass-' + s.key + '-label]', labels[s.key])
        return
      }
      const control = document.createElement('div')
      control.dataset.dshGlassControls = 'true'
      control.style.cssText = 'flex-direction:column;gap:10px;padding:16px 0;display:flex'
      const BLUR_KEYS = ['mainblur', 'popupblur']
      const ALPHA_KEYS = ['main', 'settings', 'input', 'sidebar', 'popup']
      const sliderRow = (s) =>
        '<div style="display:flex;align-items:center;gap:12px;padding-left:12px">' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px;flex:1" data-dsh-glass-' + s.key + '-label></span>' +
          '<input type="range" min="' + s.min + '" max="' + s.max + '" step="1" data-dsh-glass-' + s.key + ' style="flex:1;cursor:pointer;-webkit-appearance:none;appearance:none;height:6px;border-radius:999px;outline:none;background:linear-gradient(90deg,#4176e6 var(--dsh-' + s.key + '-fill,' + s.def + '%),rgba(65,118,230,0.22) var(--dsh-' + s.key + '-fill,' + s.def + '%));box-shadow:inset 0 0 0 1px rgba(65,118,230,0.25)">' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:12px;min-width:40px;text-align:right" data-dsh-glass-' + s.key + '-val></span>' +
        '</div>'
      const groupTitle = (dataAttr, text, first) =>
        '<div style="color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;' + (first ? '' : 'margin-top:6px;') + 'font-weight:500" ' + dataAttr + '>' + text + '</div>'
      const blurRows = SLIDERS.filter((s) => BLUR_KEYS.includes(s.key)).map(sliderRow).join('')
      const alphaRows = SLIDERS.filter((s) => ALPHA_KEYS.includes(s.key)).map(sliderRow).join('')
      const satRows = SLIDERS.filter((s) => s.key === 'saturate').map(sliderRow).join('')
      control.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:10px">' +
          '<div style="display:flex;flex-direction:column;gap:4px">' +
          groupTitle('data-dsh-glass-group-blur', labels.groupBlur, true) +
          blurRows +
          groupTitle('data-dsh-glass-group-alpha', labels.groupAlpha, false) +
          alphaRows +
          satRows +
          '</div>' +
        '</div>' +
        '<style>' +
          '[data-dsh-glass-controls] input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #4176e6;box-shadow:0 1px 4px rgba(15,20,35,0.35),0 0 0 3px rgba(65,118,230,0.18);transition:box-shadow 0.15s ease,transform 0.15s ease;cursor:pointer}' +
          '[data-dsh-glass-controls] input[type=range]:hover::-webkit-slider-thumb{box-shadow:0 1px 6px rgba(15,20,35,0.4),0 0 0 5px rgba(65,118,230,0.22)}' +
          '[data-dsh-glass-controls] input[type=range]:active::-webkit-slider-thumb{transform:scale(1.1)}' +
          '[data-dsh-glass-controls] input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #4176e6;box-shadow:0 1px 4px rgba(15,20,35,0.35);cursor:pointer}' +
          '[data-dsh-glass-controls] input[type=range]::-moz-range-track{height:6px;border-radius:999px;background:linear-gradient(90deg,#4176e6 var(--dsh-main-fill,35%),rgba(65,118,230,0.22) var(--dsh-main-fill,35%))}' +
        '</style>'
      const sync = (sel, text) => {
        const el = control.querySelector(sel)
        if (el !== null) el.textContent = text
      }
      for (const s of SLIDERS) sync('[data-dsh-glass-' + s.key + '-label]', labels[s.key])
      for (const s of SLIDERS) {
        const slider = control.querySelector('[data-dsh-glass-' + s.key + ']')
        const valEl = control.querySelector('[data-dsh-glass-' + s.key + '-val]')
        if (slider === null || valEl === null) continue
        const render = () => {
          const v = values[s.key]
          slider.value = String(v)
          valEl.textContent = v + (s.unit ?? '%')
          const pct = (v - s.min) / (s.max - s.min) * 100
          slider.style.setProperty('--dsh-' + s.key + '-fill', pct.toFixed(1) + '%')
        }
        slider.addEventListener('input', () => {
          values[s.key] = Math.round(Number(slider.value))
          write('dsh-desktop-glass-' + s.key, values[s.key])
          render()
          applyVars()
        })
        render()
      }
      const holder = panel.querySelector('[data-dsh-theme-glass-slot]') || panel
      holder.appendChild(control)
    }
    applyVars() // apply persisted values on every injection, panel open or not
    // The sidebar dark floor depends on whether a user wallpaper is set; the
    // wallpaper resolves/loads asynchronously and can change at runtime, so
    // re-apply the variables whenever it does (hook installed once; this
    // script is re-injected on every page load).
    if (window.__dshGlassWpHook === undefined) {
      window.__dshGlassWpHook = true
      window.addEventListener('dsh-wallpaper-changed', () => applyVars())
    }
    mount()
    // 主题设置 → 背景壁纸: move that section to the very top of the theme
    // options (user request). The six sections live in a flex container, so
    // order:-1 re-ranks the wallpaper block without touching the DOM order
    // (React's reconciliation never fights it).
    const reorderWallpaper = () => {
      const opts = document.querySelector('[class*="VOzbGW_options"]')
      if (opts === null) return
      // Find the flex container whose children are the theme sections.
      const container = [...opts.querySelectorAll('div')].find((d) => {
        const kids = [...d.children]
        return kids.length >= 4 && kids.some((k) => (k.textContent || '').trim().startsWith('背景壁纸'))
      })
      if (container === undefined) return
      const wp = [...container.children].find((k) => (k.textContent || '').trim().startsWith('背景壁纸'))
      if (wp !== undefined && wp.style.order !== '-2') wp.style.order = '-2'
      // 背景透明度 → 界面毛玻璃 前. order only accepts integers, so rank
      // explicitly: wallpaper -2, opacity -1, glass 0; the rest stay at the
      // default 0 and keep their DOM order after the glass section.
      const bt = [...container.children].find((k) => (k.textContent || '').trim().startsWith('背景透明度'))
      if (bt !== undefined && bt.style.order !== '-1') bt.style.order = '-1'
      const jm = [...container.children].find((k) => (k.textContent || '').trim().startsWith('界面毛玻璃'))
      if (jm !== undefined && jm.style.order !== '0') jm.style.order = '0'
    }
    reorderWallpaper()
    // The body observer keeps the glass controls mounted and the section
    // order applied while the settings panel is open.
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => { pending = false; mount(); reorderWallpaper() })
    }
    const obs = new MutationObserver(schedule)
    window.__dshGlassControlObserver = obs
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
  })()`
}

/**
 * Injected UI for a dedicated "Theme Settings" (主题设置) entry in the hosted
 * settings sidebar. Adds a nav item right after "通用设置/General" and, when
 * clicked, hides the SPA's own sections and mounts a theme panel that hosts
 * the background-opacity slider, the cursor effects and the wallpaper picker
 * (all injected by alphaControlScript / wallpaperControlScript into the
 * `[data-dsh-theme-controls]` holder).
 *
 * The click is captured and stopped so React never switches to a view it does
 * not know; active-state highlighting is simulated by toggling the same class
 * the SPA uses. A self-healing observer re-inserts the nav cell whenever the
 * settings panel is rebuilt, closes the panel when the user picks another
 * entry (the SPA re-renders its own content), and re-opens it if the SPA
 * re-renders the content area while the theme panel is open.
 */
export function themeSettingsScript(): string {
  return `(() => {
    if (window.__dshThemeSettings) {
      try { window.__dshThemeSettings.cleanup() } catch {}
    }
    const CELL_SEL = '[class*="_navCell"]'
    const state = { cell: null, navList: null, open: false }
    let healTimer = null
    const findNavList = () => document.querySelector('[class*="_navList"]')
    const findOptions = () => {
      // Anchor on the settings nav list and walk UP to the panel: a bare
      // [class*="_panel"] query can match an SVG (whose className is a
      // non-string object) elsewhere in the page.
      const nav = document.querySelector('[class*="_navList"]')
      const panel = nav === null ? null : nav.closest('div[class*="_panel"]')
      return panel === null ? null : panel.querySelector('[class*="_options"]')
    }
    const locale = () => {
      const list = findNavList()
      if (list === null) return 'zh'
      const t = list.textContent ?? ''
      return /General/.test(t) && !/通用设置/.test(t) ? 'en' : 'zh'
    }
    const themeTitle = () => (locale() === 'zh' ? '主题设置' : 'Theme')
    const activeClass = () => {
      // Any highlighted cell, not just the first one: when the user had
      // switched to e.g. 插件 the highlight lives on that entry, and the
      // first cell (通用设置) is not active at all.
      const cell = Array.from(document.querySelectorAll(CELL_SEL)).find((c) => /active/i.test(c.className))
      return cell === undefined ? undefined : Array.from(cell.classList).find((c) => /active/i.test(c))
    }
    // The cell whose highlight we borrow while the theme panel is open, so
    // closing restores it (React will not re-render the nav on its own: the
    // injected button is invisible to React, so nothing triggers a repaint).
    let prevActiveCell = null
    let prevActiveClass = null
    const setActive = (on) => {
      if (state.cell === null) return
      // Fall back to the button's own active class: during a nav re-render
      // there may be no other active cell to sample from.
      const act = activeClass() ?? Array.from(state.cell.classList).find((c) => /active/i.test(c))
      if (act === undefined) return
      if (on) {
        // Highlight ours; remember (and dim) the SPA's current cell.
        const cur = Array.from(document.querySelectorAll(CELL_SEL)).find((c) => c !== state.cell && c.classList.contains(act))
        if (cur !== undefined) {
          prevActiveCell = cur
          prevActiveClass = act
          cur.classList.remove(act)
        }
        state.cell.classList.add(act)
      } else {
        // Close only dims OUR entry; never touch the SPA's own highlight.
        state.cell.classList.remove(act)
        // Restore the borrowed highlight — unless the SPA has since
        // highlighted another entry (the user switched views meanwhile).
        const current = Array.from(document.querySelectorAll(CELL_SEL)).find((c) => c !== state.cell && c.classList.contains(act))
        if (current === undefined && prevActiveCell !== null && prevActiveClass !== null && document.body.contains(prevActiveCell)) {
          prevActiveCell.classList.add(prevActiveClass)
        }
        prevActiveCell = null
        prevActiveClass = null
      }
    }
    const ensureCell = () => {
      const list = findNavList()
      if (list === null) return
      const nav = list.parentElement
      if (nav === null) return
      // Native nav cells: close our panel before React handles their click,
      // so switching entries never leaves the theme panel behind.
      for (const c of list.querySelectorAll(CELL_SEL)) {
        if (c.dataset.dshNavGuard === '1') continue
        c.dataset.dshNavGuard = '1'
        c.addEventListener('click', () => {
          if (state.open) closePanel()
        }, true)
      }
      if (nav.querySelector('[data-dsh-theme-nav]') !== null) {
        const span = nav.querySelector('[data-dsh-theme-nav] span')
        const t = themeTitle()
        if (span !== null && span.textContent !== t) span.textContent = t
        state.cell = nav.querySelector('[data-dsh-theme-nav]')
        return
      }
      const sample = list.querySelector(CELL_SEL)
      if (sample === null) return
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = sample.className
      // Do not inherit the sample's active highlight (the SPA's nav is
      // usually showing 通用设置 as active when we first mount).
      for (const c of btn.classList) {
        if (/active/i.test(c)) btn.classList.remove(c)
      }
      btn.dataset.dshThemeNav = 'true'
      // Theme entry gets its own palette icon (16×16 fill style matching the
      // SPA's nav icons) instead of cloning the sample's gear.
      const iconWrap = document.createElement('div')
      iconWrap.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1C4.14 1 1 4.14 1 8c0 3.87 3.13 7 7 7 .78 0 1.35-.57 1.35-1.33 0-.33-.14-.63-.38-.84-.24-.23-.38-.53-.38-.87 0-.73.59-1.33 1.33-1.33h1.53c2.8 0 5.05-2.4 5.05-5.63C16.5 3.4 12.7 1 8 1z"/><circle cx="4" cy="6.9" r="1.5"/><circle cx="6.6" cy="3.6" r="1.5"/><circle cx="10.6" cy="3.8" r="1.5"/><circle cx="12.7" cy="6.9" r="1.5"/></svg>'
      const icon = iconWrap.firstElementChild
      if (icon !== null) {
        const iconSample = sample.querySelector('svg')
        if (iconSample !== null && iconSample.getAttribute('class') !== null) {
          icon.setAttribute('class', iconSample.getAttribute('class'))
        }
        btn.appendChild(icon)
      }
      const span = document.createElement('span')
      const labelSample = sample.querySelector('span')
      span.className = labelSample !== null ? labelSample.className : ''
      span.textContent = themeTitle()
      btn.appendChild(span)
      // Append AFTER the nav list, as a sibling of the list inside the nav
      // container. A button injected INTO the list skews React's implicit
      // index keys, so React maps its click onto a neighbouring entry (e.g.
      // 模型) and switches the content view. As a sibling, React resolves the
      // click to the nav container (which has no handler) and leaves it alone.
      nav.appendChild(btn)
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (state.open) closePanel()
        else openPanel()
      })
      state.cell = btn
    }
    const openPanel = () => {
      const options = findOptions()
      if (options === null || state.open) return
      // Hide EVERY direct child so the panel reads as a real settings page:
      // some views (e.g. 插件) wrap their content in a container without the
      // _section class, so matching only _section leaks that content behind.
      for (const s of options.querySelectorAll(':scope > *')) {
        if (s.dataset.dshThemePanel !== undefined) continue
        s.style.display = 'none'
      }
      window.__dshThemeLocale = locale()
      const sample = options.querySelector(':scope > *:not([data-dsh-theme-panel])')
      const panel = document.createElement('div')
      panel.dataset.dshThemePanel = 'true'
      if (sample !== null) panel.className = sample.className
      panel.style.cssText = 'display:flex;flex-direction:column'
      const group = document.createElement('div')
      group.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:0 4px'
      // No panel title here: the sidebar nav already says 主题设置, so a
      // repeated heading above the first control (背景壁纸) is redundant.
      const controls = document.createElement('div')
      controls.dataset.dshThemeControls = 'true'
      controls.style.cssText = 'display:flex;flex-direction:column'
      // Fixed order via dedicated slots: interface glass first (the most
      // used control), then the brand color-switch interval (before the
      // opacity slider per user preference), the opacity slider, the
      // wallpaper block, and the panel-visibility toggles last. Mounting
      // order of the injected controls is otherwise racy (observer-driven).
      const glassSlot = document.createElement('div')
      glassSlot.dataset.dshThemeGlassSlot = 'true'
      const cycleSlot = document.createElement('div')
      cycleSlot.dataset.dshThemeCycleSlot = 'true'
      const alphaSlot = document.createElement('div')
      alphaSlot.dataset.dshThemeAlphaSlot = 'true'
      const wallpaperSlot = document.createElement('div')
      wallpaperSlot.dataset.dshThemeWallpaperSlot = 'true'
      const featureSlot = document.createElement('div')
      featureSlot.dataset.dshThemeFeatureSlot = 'true'
      controls.appendChild(glassSlot)
      controls.appendChild(cycleSlot)
      controls.appendChild(alphaSlot)
      controls.appendChild(wallpaperSlot)
      controls.appendChild(featureSlot)
      group.appendChild(controls)
      panel.appendChild(group)
      options.appendChild(panel)
      state.open = true
      setActive(true)
    }
    const closePanel = () => {
      const panel = document.querySelector('[data-dsh-theme-panel]')
      if (panel !== null) panel.remove()
      const options = findOptions()
      if (options !== null) {
        for (const s of options.querySelectorAll(':scope > *')) {
          if (s.dataset.dshThemePanel !== undefined) continue
          s.style.display = ''
        }
      }
      state.open = false
      setActive(false)
    }
    // One narrow childList observer on body only: re-insert the nav cell when
    // the settings panel is (re)built, and re-mount the theme panel after
    // React re-renders the content area (React owns the click, so it clears
    // our panel on the first open). A body-wide attributes observer would
    // storm the renderer — the SPA churns class names and DOM nodes
    // constantly.
    const healTick = () => {
      const list = findNavList()
      if (list === null) {
        // Settings panel closed entirely (nav unmounted): reset so the next
        // open starts fresh on the SPA's own view, not an auto-opened theme.
        if (healTimer !== null) { clearTimeout(healTimer); healTimer = null }
        state.cell = null
        state.navList = null
        if (state.open) state.open = false
        return
      }
      if (list !== state.navList) state.navList = list
      // Tag the hosted settings panel so the ambient CSS can give the whole
      // SETTINGS surface its own frosted glass (设置界面毛玻璃 slider) instead
      // of the SPA's opaque fill.
      const settingsPanel = list.closest('div[class*="_panel"]')
      if (settingsPanel !== null && settingsPanel.getAttribute('data-dsh-settings-panel') !== 'true') {
        settingsPanel.setAttribute('data-dsh-settings-panel', 'true')
      }
      ensureCell()
      if (!state.open) return
      if (document.querySelector('[data-dsh-theme-panel]') === null) {
        // Debounced heal: give React's render a beat before re-mounting.
        if (healTimer !== null) clearTimeout(healTimer)
        healTimer = setTimeout(() => {
          healTimer = null
          if (state.open && document.querySelector('[data-dsh-theme-panel]') === null) openPanel()
        }, 30)
      }
    }
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => { pending = false; healTick() })
    }
    const obs = new MutationObserver(schedule)
    obs.observe(document.body, { childList: true, subtree: true })
    ensureCell()
    window.__dshThemeSettings = {
      cleanup: () => { obs.disconnect(); if (healTimer !== null) clearTimeout(healTimer); closePanel() },
    }
  })()`
}
