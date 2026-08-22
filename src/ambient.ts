/**
 * 悬停效果 (hover effects) — 移植自 DSH-Transparent-UI-Plugin 的
 * 「装饰:悬停效果」分组:鼠标辉光 + 悬停下压。原插件把两套交互
 * (spotlight.ts 的辉光/几何倾斜 + spot-core.ts 的几何维护 + seam-stamper
 * 的打标)挂到网页端皮肤层上,这里搬进桌面壳,开关收进 主题设置 → 悬停效果。
 *
 * - 鼠标辉光 (spotlight):蓝色径向光斑(180px)跟随光标,渲染在玻璃面板
 *   内部的 z-index:-1 覆盖层上,透过半透明表面弥散,不覆盖内容。
 * - 悬停下压 (press):面板随光标几何倾斜(perspective 800px,边角约 1°),
 *   ease-out 过渡 + 240ms 回弹;设置面板打开时侧边栏暂停下压,避免
 *   transform 把面板的 fixed overlay 重新锚定进列里。
 *
 * 两个 html 属性 gate:data-dsh-hover-spotlight / data-dsh-hover-press,
 * 任一开启时悬停跟踪运行。开关持久化在 localStorage(dsh-desktop-hover-*),
 * 默认全开。
 */

/**
 * 注入悬停效果引擎 + 主题设置面板的「悬停效果」分组开关。
 * @returns 一段可 executeJavaScript 的 IIFE 脚本。
 */
export function ambientDecorScript(): string {
  return `(() => {
    if (window.__dshAmbientDecor) {
      window.__dshAmbientDecor.dispose()
      window.__dshAmbientDecor = undefined
    }
    // ── 状态与持久化(默认全开) ──
    const KEYS = {
      spotlight: 'dsh-desktop-hover-spotlight',
      press: 'dsh-desktop-hover-press',
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
    const state = {
      spotlight: read(KEYS.spotlight, true) !== false,
      press: read(KEYS.press, false) !== false,
    }
    const isDark = () => document.body.hasAttribute('data-ds-dark-theme')

    // ── CSS:悬停效果样式(唯一注入一次) ──
    const CSS = [
      // spot 面板创建隔离上下文,让 glow(z-index:-1)待在面板内部。
      'html[data-dsh-hover-spotlight] [data-dsh-aqua-spot]{position:relative;isolation:isolate}',
      // glow 覆盖层:默认 inert,仅辉光开启且悬停时点亮。
      '[data-dsh-aqua-glow]{display:none}',
      'html[data-dsh-hover-spotlight] [data-dsh-aqua-glow]{display:block;position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity 0.3s ease;z-index:-1}',
      'html[data-dsh-hover-spotlight] [data-dsh-aqua-spot][data-spot-on] [data-dsh-aqua-glow]{opacity:1}',
      // 融合的输入框+统计行 spot 是隐形包装,辉光用卡片 24px 圆角。
      'html[data-dsh-hover-spotlight] [data-dsh-inputbar][data-dsh-aqua-spot] [data-dsh-aqua-glow]{border-radius:24px}',
      // 下压:JS 写 perspective+rotate 内联。无 transition——瞬时应用:
      // transform 过渡动画期间 backdrop-filter 逐帧重采样是闪烁根因
      // (硬件 GL 下 blur 真实生效后),瞬时变换只重采样 1 次,无动画期。
      'html[data-dsh-hover-press] [data-dsh-aqua-spot]{transition:none}',
    ].join('')
    let cssEl = document.getElementById('dsh-ambient-css')
    if (cssEl === null) {
      cssEl = document.createElement('style')
      cssEl.id = 'dsh-ambient-css'
      document.head.appendChild(cssEl)
    }
    cssEl.textContent = CSS

    // ── spot 打标(seam-stamper 移植):先打输入栏/统计行 seam(spot
    //    选择器依赖它们),再打 spot 标记。 ──
    const SEAMS = [
      { attribute: 'data-dsh-inputbar', selector: ':has(> [data-composer-card])' },
      { attribute: 'data-dsh-stats', selector: '[data-slot="conversation.composer.dock"] [class*="root"]' },
    ]
    const SPOT_SEAMS = [
      { attribute: 'data-dsh-aqua-spot', selector: 'header', first: true },
      { attribute: 'data-dsh-aqua-spot', selector: '[class*="sidebarCol"]', first: true },
      { attribute: 'data-dsh-aqua-spot', selector: '[data-dsh-inputbar]' },
      { attribute: 'data-dsh-aqua-spot', selector: '[data-conversation-composer-overlay]' },
      { attribute: 'data-dsh-aqua-spot', selector: 'button[class*="newSession"]' },
    ]
    const stampAll = () => {
      for (const seam of SEAMS) {
        for (const el of document.querySelectorAll(seam.selector)) {
          if (!el.hasAttribute(seam.attribute)) el.setAttribute(seam.attribute, '')
        }
      }
      for (const seam of SPOT_SEAMS) {
        if (seam.first) {
          const el = document.querySelector(seam.selector)
          if (el !== null && !el.hasAttribute(seam.attribute)) el.setAttribute(seam.attribute, '')
          continue
        }
        for (const el of document.querySelectorAll(seam.selector)) {
          if (!el.hasAttribute(seam.attribute)) el.setAttribute(seam.attribute, '')
        }
      }
    }
    stampAll()
    const seamObserver = new MutationObserver(() => { stampAll() })
    seamObserver.observe(document.documentElement, { childList: true, subtree: true })

    // ── spot-core:spot 几何 + 辉光覆盖层维护 ──
    const SPOT_SELECTOR = '[data-dsh-aqua-spot]'
    const GLOW_ATTR = 'data-dsh-aqua-glow'
    const ON_ATTR = 'data-spot-on'
    const closestSpot = (target) => (target instanceof Element ? target.closest(SPOT_SELECTOR) : null)
    const spotElements = () => Array.from(document.querySelectorAll(SPOT_SELECTOR))
    const visualRect = (spot) => {
      const card = spot.querySelector('[data-composer-card]')
      if (card === null) return spot.getBoundingClientRect()
      const r0 = card.getBoundingClientRect()
      const stats = spot.querySelector('[data-dsh-stats]')
      if (stats === null) return r0
      const r1 = stats.getBoundingClientRect()
      const left = Math.min(r0.left, r1.left)
      const top = Math.min(r0.top, r1.top)
      return new DOMRect(left, top, Math.max(r0.right, r1.right) - left, Math.max(r0.bottom, r1.bottom) - top)
    }
    const inside = (visual, clientX, clientY) => {
      return clientX >= visual.left && clientX <= visual.right
        && clientY >= visual.top && clientY <= visual.bottom
    }
    const localTopLeft = (el, ancestor) => {
      let x = 0
      let y = 0
      let node = el
      while (node !== null && node !== ancestor) {
        x += node.offsetLeft
        y += node.offsetTop
        node = node.offsetParent
      }
      return { x, y }
    }
    const glassLocalRect = (spot) => {
      const card = spot.querySelector('[data-composer-card]')
      if (card === null) {
        return { left: 0, top: 0, width: spot.offsetWidth, height: spot.offsetHeight }
      }
      const cardPos = localTopLeft(card, spot)
      let left = cardPos.x
      let top = cardPos.y
      let right = left + card.offsetWidth
      let bottom = top + card.offsetHeight
      const stats = spot.querySelector('[data-dsh-stats]')
      if (stats !== null) {
        const statsPos = localTopLeft(stats, spot)
        left = Math.min(left, statsPos.x)
        top = Math.min(top, statsPos.y)
        right = Math.max(right, statsPos.x + stats.offsetWidth)
        bottom = Math.max(bottom, statsPos.y + stats.offsetHeight)
      }
      return { left, top, width: right - left, height: bottom - top }
    }
    const ensureGlow = (spot) => {
      let glow = spot.querySelector(':scope > [data-dsh-aqua-glow]')
      if (glow === null) {
        glow = document.createElement('div')
        glow.setAttribute(GLOW_ATTR, '')
        glow.setAttribute('aria-hidden', 'true')
        spot.appendChild(glow)
      }
      return glow
    }
    const startOverlayKeeper = (onChange) => {
      const tick = () => {
        for (const spot of spotElements()) ensureGlow(spot)
        onChange()
      }
      tick()
      const observer = new MutationObserver(tick)
      observer.observe(document.documentElement, { childList: true, subtree: true })
      window.addEventListener('resize', tick, { passive: true })
      return () => {
        observer.disconnect()
        window.removeEventListener('resize', tick)
        for (const glow of document.querySelectorAll('[data-dsh-aqua-glow]')) glow.remove()
      }
    }

    // ── 辉光 + 下压控制器(spotlight.ts 移植) ──
    const glowGated = () => document.documentElement.hasAttribute('data-dsh-hover-spotlight')
    const tiltGated = () => document.documentElement.hasAttribute('data-dsh-hover-press')
    const hoverGated = () => glowGated() || tiltGated()
    const tiltable = (spot) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
      // 设置面板渲染在侧边栏列内:面板打开时侧边栏暂停下压,避免 transform
      // 把面板的 fixed overlay 重新锚定进列里。
      if (spot.matches('[class*="sidebarCol"]')) {
        if (document.querySelector('[role="dialog"]') !== null) return false
        if (document.querySelector('[data-dsh-theme-panel]') !== null) return false
      }
      return true
    }
    const GLOW_RADIUS = 180
    const GLOW_FALLBACK = 'rgba(90, 215, 255, 0.17)'
    const TILT_MAX = 0.0175
    const TILT_PERSPECTIVE = 800
    const SETTLE_MS = 240
    const startSpotlight = () => {
      let current = null
      let session = null
      let raf = 0
      let refreshRaf = 0
      let pressTimer = 0
      const tilted = new WeakSet()
      const settle = new Map()
      const easeBack = (spot) => {
        if (!tilted.has(spot)) return
        tilted.delete(spot)
        spot.style.transform = 'perspective(' + TILT_PERSPECTIVE + 'px) rotateX(0rad) rotateY(0rad) scale(1)'
        const id = window.setTimeout(() => {
          settle.delete(spot)
          spot.style.removeProperty('transform')
          spot.style.removeProperty('transform-origin')
        }, SETTLE_MS)
        settle.set(spot, id)
      }
      const clearSpot = (spot) => {
        spot.removeAttribute(ON_ATTR)
        if (current === spot) {
          current = null
          session = null
        }
        if (pressTimer !== 0) { clearTimeout(pressTimer); pressTimer = 0 }
        const glow = spot.querySelector(':scope > [data-dsh-aqua-glow]')
        // 固定渐变保留(measure 会在 bg 空时重设);只清 transform 让光斑回位。
        if (glow !== null) glow.style.removeProperty('transform')
        easeBack(spot)
      }
      const measure = (spot) => {
        const visual = visualRect(spot)
        const local = glassLocalRect(spot)
        const glow = glowGated() ? ensureGlow(spot) : null
        if (glow !== null) {
          // 光斑层覆盖 spot 视觉矩形 + 光斑半径边距(几何只设一次, 之后仅
          // transform 移动光斑——合成器动画, 零重绘, 不触发 backdrop 重采样)
          glow.style.left = (local.left - GLOW_RADIUS) + 'px'
          glow.style.top = (local.top - GLOW_RADIUS) + 'px'
          glow.style.width = (local.width + GLOW_RADIUS * 2) + 'px'
          glow.style.height = (local.height + GLOW_RADIUS * 2) + 'px'
          // 渐变是固定 50% 50% 的一次性设置,但可能被 clearSpot/关辉光清掉,
          // 所以每次 measure 发现 bg 为空就重设,避免光斑永久丢失。
          if (glow.dataset.glowCenter === undefined || glow.style.backgroundImage === '') {
            glow.dataset.glowCenter = '1'
            glow.style.backgroundImage = 'radial-gradient(' + GLOW_RADIUS + 'px at 50% 50%, var(--dsh-aqua-spot-color, ' + GLOW_FALLBACK + '), transparent 70%)'
          }
        }
        return { spot, visual, local, glow }
      }
      const paint = (s, clientX, clientY) => {
        if (raf !== 0) return
        raf = requestAnimationFrame(() => {
          raf = 0
          const spot = s.spot
          const visual = s.visual
          const local = s.local
          if (!inside(visual, clientX, clientY)) {
            clearSpot(spot)
            return
          }
          let glow = s.glow
          if (glow === null && glowGated()) {
            s = session = measure(spot)
            glow = s.glow
          }
          if (glow !== null) {
            if (glowGated()) {
              // 合成器 transform 移动光斑(光斑层中心=spot 中心, 渐变固定 50% 50%):
              // 每帧只改 transform, GPU 合成, 零重绘, 不触发 backdrop 重采样。
              glow.style.transform = 'translate(' + ((clientX - visual.left) - (local.left + local.width / 2)) + 'px, ' + ((clientY - visual.top) - (local.top + local.height / 2)) + 'px)'
            } else {
              glow.style.transform = ''
              glow.style.removeProperty('background-image')
              delete glow.dataset.glowCenter
            }
          }
          if (tiltGated() && tiltable(spot)) {
            const dx = Math.min(0.5, Math.max(-0.5, (clientX - visual.left) / visual.width - 0.5))
            const dy = Math.min(0.5, Math.max(-0.5, (clientY - visual.top) / visual.height - 0.5))
            const tiltMax = spot.hasAttribute('data-dsh-trajectory') ? TILT_MAX * 0.5 : TILT_MAX
            // 停顿防抖:移动中不更新 transform(避免 blur 面板每帧重采样闪烁),
            // 鼠标停顿 80ms 后才应用一次下压;移动期间保持上一个角度。
            if (pressTimer !== 0) clearTimeout(pressTimer)
            pressTimer = window.setTimeout(() => {
              pressTimer = 0
              spot.style.transformOrigin = (local.left + local.width / 2) + 'px ' + (local.top + local.height / 2) + 'px'
              spot.style.transform = 'perspective(' + TILT_PERSPECTIVE + 'px) rotateX(' + (tiltMax * -2 * dy) + 'rad) rotateY(' + (tiltMax * 2 * dx) + 'rad) scale(1.01)'
              tilted.add(spot)
            })
          } else if (tilted.has(spot)) {
            easeBack(spot)
          }
        })
      }
      const onMove = (event) => {
        if (!hoverGated()) return
        const spot = closestSpot(event.target)
        if (spot === null || (session !== null && session.spot !== spot)) return
        paint(session, event.clientX, event.clientY)
      }
      const onOver = (event) => {
        if (!hoverGated()) return
        const spot = closestSpot(event.target)
        if (spot === null) return
        if (spot.matches('[class*="sidebarCol"]')) {
          if (document.querySelector('[role="dialog"]') !== null) return
          if (document.querySelector('[data-dsh-theme-panel]') !== null) return
        }
        const next = measure(spot)
        if (!inside(next.visual, event.clientX, event.clientY)) return
        const id = settle.get(spot)
        if (id !== undefined) {
          clearTimeout(id)
          settle.delete(spot)
        }
        spot.setAttribute(ON_ATTR, '')
        current = spot
        session = next
        paint(next, event.clientX, event.clientY)
      }
      const onOut = (event) => {
        const spot = closestSpot(event.target)
        if (spot === null || spot !== current) return
        if (session !== null && inside(session.visual, event.clientX, event.clientY)) return
        clearSpot(spot)
      }
      const keeper = startOverlayKeeper(() => {
        for (const spot of spotElements()) {
          if (!spot.matches('[class*="sidebarCol"]')) continue
          if (spot.querySelector('[role="dialog"]') === null && spot.querySelector('[data-dsh-theme-panel]') === null) continue
          spot.removeAttribute(ON_ATTR)
          const id = settle.get(spot)
          if (id !== undefined) {
            clearTimeout(id)
            settle.delete(spot)
          }
          tilted.delete(spot)
          spot.style.setProperty('transition', 'none')
          spot.style.removeProperty('transform')
          spot.style.removeProperty('transform-origin')
          void spot.offsetWidth
          spot.style.removeProperty('transition')
          if (current === spot) {
            current = null
            session = null
          }
        }
        if (session === null || refreshRaf !== 0) return
        refreshRaf = requestAnimationFrame(() => {
          refreshRaf = 0
          if (session !== null) session = measure(session.spot)
        })
      })
      document.addEventListener('pointermove', onMove, { passive: true })
      document.addEventListener('pointerover', onOver, { passive: true })
      document.addEventListener('pointerout', onOut, { passive: true })
      return () => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerover', onOver)
        document.removeEventListener('pointerout', onOut)
        keeper()
        if (pressTimer !== 0) { clearTimeout(pressTimer); pressTimer = 0 }
        if (raf !== 0) cancelAnimationFrame(raf)
        if (refreshRaf !== 0) cancelAnimationFrame(refreshRaf)
        for (const id of settle.values()) clearTimeout(id)
        settle.clear()
        for (const spot of spotElements()) {
          spot.removeAttribute(ON_ATTR)
          if (tilted.has(spot)) {
            tilted.delete(spot)
            spot.style.removeProperty('transform')
            spot.style.removeProperty('transform-origin')
          }
        }
      }
    }
    const spotlightDisposer = startSpotlight()

    // ── gate 同步 + 辉光颜色 ──
    const updateSpotColor = () => {
      document.documentElement.style.setProperty('--dsh-aqua-spot-color', isDark() ? 'hsla(216, 90%, 62%, 0.17)' : 'hsla(216, 90%, 45%, 0.16)')
    }
    const sync = () => {
      updateSpotColor()
      document.documentElement.toggleAttribute('data-dsh-hover-spotlight', state.spotlight)
      document.documentElement.toggleAttribute('data-dsh-hover-press', state.press)
    }
    sync()
    // 主题深浅切换时刷新辉光颜色。
    const darkObserver = new MutationObserver(() => { updateSpotColor() })
    darkObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })

    // ── 主题设置面板:悬停效果分组开关 ──
    const mountUI = () => {
      if (window.dshDesktop === undefined) return
      const panel = document.querySelector('[data-dsh-theme-panel]')
      if (panel === null) return
      const zh = window.__dshThemeLocale !== 'en'
      const labels = {
        hoverTitle: zh ? '悬停效果' : 'Hover effects',
        spotlight: zh ? '鼠标辉光' : 'Cursor glow',
        press: zh ? '悬停下压' : 'Hover press',
      }
      const MOUNTED = '[data-dsh-hover-controls]'
      const existing = document.querySelector(MOUNTED)
      if (existing !== null) {
        const syncText = (sel, text) => {
          const el = existing.querySelector(sel)
          if (el !== null && el.textContent !== text) el.textContent = text
        }
        syncText('[data-dsh-hover-title]', labels.hoverTitle)
        syncText('[data-dsh-label-spotlight]', labels.spotlight)
        syncText('[data-dsh-label-press]', labels.press)
        return
      }
      const control = document.createElement('div')
      control.dataset.dshHoverControls = 'true'
      control.style.cssText = 'flex-direction:column;gap:12px;padding:16px 0;display:flex'
      control.innerHTML =
        '<div style="color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px" data-dsh-hover-title></div>' +
        '<label style="display:flex;align-items:center;gap:10px;cursor:pointer">' +
          '<span class="dsh-switch">' +
            '<input type="checkbox" data-dsh-toggle-spotlight>' +
            '<span class="track"></span><span class="thumb"></span>' +
          '</span>' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px" data-dsh-label-spotlight></span>' +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:10px;cursor:pointer">' +
          '<span class="dsh-switch">' +
            '<input type="checkbox" data-dsh-toggle-press>' +
            '<span class="track"></span><span class="thumb"></span>' +
          '</span>' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px" data-dsh-label-press></span>' +
        '</label>' +
        '<style>' +
          '[data-dsh-hover-controls] .dsh-switch { position:relative; width:36px; height:20px; flex:none; }' +
          '[data-dsh-hover-controls] .dsh-switch input { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; z-index:1; }' +
          '[data-dsh-hover-controls] .dsh-switch .track { position:absolute; inset:0; border-radius:999px; background:rgba(128,132,142,0.35); box-shadow:inset 0 0 0 1px rgba(255,255,255,0.08); transition:background 0.15s ease; }' +
          '[data-dsh-hover-controls] .dsh-switch .thumb { position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.35); transition:transform 0.15s ease; }' +
          '[data-dsh-hover-controls] .dsh-switch input:checked ~ .track { background:#4176e6; }' +
          '[data-dsh-hover-controls] .dsh-switch input:checked ~ .thumb { transform:translateX(16px); }' +
        '</style>'
      const titleEl = control.querySelector('[data-dsh-hover-title]')
      if (titleEl !== null) titleEl.textContent = labels.hoverTitle
      const syncText = (sel, text) => {
        const el = control.querySelector(sel)
        if (el !== null) el.textContent = text
      }
      syncText('[data-dsh-label-spotlight]', labels.spotlight)
      syncText('[data-dsh-label-press]', labels.press)
      const spotlightToggle = control.querySelector('[data-dsh-toggle-spotlight]')
      const pressToggle = control.querySelector('[data-dsh-toggle-press]')
      if (spotlightToggle === null || pressToggle === null) return
      spotlightToggle.checked = state.spotlight
      pressToggle.checked = state.press
      spotlightToggle.addEventListener('change', () => {
        state.spotlight = spotlightToggle.checked
        write(KEYS.spotlight, state.spotlight)
        sync()
      })
      pressToggle.addEventListener('change', () => {
        state.press = pressToggle.checked
        write(KEYS.press, state.press)
        sync()
      })
      const holder = panel.querySelector('[data-dsh-theme-hover-slot]') || panel
      holder.appendChild(control)
    }
    mountUI()
    const uiObserver = new MutationObserver(mountUI)
    uiObserver.observe(document.body, { childList: true, subtree: true, characterData: true })

    window.__dshAmbientDecor = {
      dispose: () => {
        darkObserver.disconnect()
        uiObserver.disconnect()
        seamObserver.disconnect()
        spotlightDisposer()
        document.documentElement.removeAttribute('data-dsh-hover-spotlight')
        document.documentElement.removeAttribute('data-dsh-hover-press')
        document.documentElement.style.removeProperty('--dsh-aqua-spot-color')
        const st = document.getElementById('dsh-ambient-css')
        if (st !== null) st.remove()
      },
    }
  })()`
}
