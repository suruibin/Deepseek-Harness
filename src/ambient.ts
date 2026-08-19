/**
 * 环境装饰 (ambient decoration) — 移植自 DSH-Transparent-UI-Plugin 的
 * 「环境装饰」分组:粒子鲸鱼 / 环境生物 / 交互网格。原插件是一个挂在
 * 网页端皮肤层上的插件,这里把三个效果搬进桌面壳,直接以注入脚本运行,
 * 开关统一收进 主题设置 → 环境装饰。
 *
 * 层级:一个 fixed 全屏容器 `#dsh-dt-ambient`(z-index:-1,pointer-events
 * 穿透)挂在 body 末尾,排在壁纸层 `#dsh-dt-wallpaper` 之后(DOM 顺序靠后,
 * 同为 -1 所以画在壁纸之上),应用内容之下;侧边栏/主界面的半透明毛玻璃
 * 让装饰从玻璃底下透出。
 *
 * - 粒子鲸鱼 (whale):deepseek.com/harness 官网同款粒子鱼,采样品牌鱼
 *   SVG 成 60×60 亮度网格,粒子散开再聚合成鱼形,带漂移/摆尾/光照/指针
 *   扰动,30fps,居中于主列(回退到窗口中心)。
 * - 环境生物 (critters):品牌鱼剪影游动、气泡上浮、浮游生物闪烁,纯
 *   CSS 动画(尊重 prefers-reduced-motion)。
 * - 交互网格 (mesh):官网 dot-grid 装饰,90px 点阵,指针 140px 内斥力
 *   弹簧物理,30fps 空闲暂停。
 *
 * 开关持久化在 localStorage(dsh-desktop-ambient-*),默认全开。
 */

/** 粒子鲸鱼采样源:DeepSeek 品牌鱼 SVG(24×18,官网 HeroDigitileR3F 素材)。 */
const WHALE_SVG = '<svg width="24" height="18" viewBox="0 0 24 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746V14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z" fill="#FFFFFF"/></svg>'

/** 环境生物鱼形剪影 path(与 WHALE_SVG 同源,figma 提取)。 */
const FISH_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'

/**
 * 注入环境装饰引擎 + 主题设置面板的「环境装饰」分组开关。
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
      whale: 'dsh-desktop-ambient-whale',
      critters: 'dsh-desktop-ambient-critters',
      mesh: 'dsh-desktop-ambient-mesh',
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
      whale: read(KEYS.whale, true) !== false,
      critters: read(KEYS.critters, true) !== false,
      mesh: read(KEYS.mesh, true) !== false,
      spotlight: read(KEYS.spotlight, true) !== false,
      press: read(KEYS.press, true) !== false,
    }
    const isDark = () => document.body.hasAttribute('data-ds-dark-theme')

    // ── CSS:环境装饰样式(唯一注入一次) ──
    const CSS = [
      '#dsh-dt-ambient{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}',
      '@media (prefers-reduced-motion: no-preference){#dsh-dt-ambient{animation:dsh-ambient-breathe 9s var(--ds-ease-in-out,ease-in-out) infinite alternate}}',
      '@keyframes dsh-ambient-breathe{from{opacity:0.86}to{opacity:1}}',
      '#dsh-dt-ambient [data-dsh-ambient-whale]{position:absolute;transform:translate(-50%,-50%);pointer-events:none;mix-blend-mode:screen;opacity:0.92}',
      '#dsh-dt-ambient [data-dsh-ambient-whale][data-scheme="light"]{mix-blend-mode:multiply}',
      '#dsh-dt-ambient [data-dsh-ambient-whale] canvas{display:block;width:100%;height:100%}',
      '#dsh-dt-ambient [data-dsh-ambient-mesh]{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}',
      '#dsh-dt-ambient[data-critters="off"] [data-aqua-critter]{display:none}',
      '#dsh-dt-ambient [data-aqua-critter]{position:absolute;color:#7ea4df;opacity:0.22}',
      '#dsh-dt-ambient [data-aqua-critter="fish"]{animation:dsh-aqua-fish-swim 12s var(--ds-ease-in-out,ease-in-out) infinite}',
      '#dsh-dt-ambient [data-aqua-critter="fish-left"]{animation:dsh-aqua-fish-swim-left 16s var(--ds-ease-in-out,ease-in-out) infinite}',
      '#dsh-dt-ambient [data-aqua-critter="bubble"]{color:#a9c6ef;opacity:0;animation:dsh-aqua-bubble-rise 9s ease-in infinite}',
      '#dsh-dt-ambient [data-aqua-critter="plankton"]{color:#7ea4df;animation:dsh-aqua-plankton 5s ease-in-out infinite}',
      '@keyframes dsh-aqua-fish-swim{0%{transform:translate3d(0,0,0) rotate(-5deg)}30%{transform:translate3d(40px,-15px,0) rotate(4deg)}70%{transform:translate3d(52px,-18px,0) rotate(3deg)}100%{transform:translate3d(0,0,0) rotate(-5deg)}}',
      '@keyframes dsh-aqua-fish-swim-left{0%{transform:translate3d(0,0,0) scaleX(-1) rotate(-5deg)}30%{transform:translate3d(-34px,-12px,0) scaleX(-1) rotate(4deg)}70%{transform:translate3d(-44px,-15px,0) scaleX(-1) rotate(3deg)}100%{transform:translate3d(0,0,0) scaleX(-1) rotate(-5deg)}}',
      '@keyframes dsh-aqua-bubble-rise{0%{transform:translate3d(0,0,0);opacity:0}10%{opacity:0.5}100%{transform:translate3d(8px,-150px,0);opacity:0}}',
      '@keyframes dsh-aqua-plankton{0%,100%{opacity:0.15;transform:scale(0.8)}50%{opacity:0.9;transform:scale(1.15)}}',
      // ── 悬停效果:鼠标辉光 + 悬停下压 ──
      // spot 面板创建隔离上下文,让 glow(z-index:-1)待在面板内部。
      'html[data-dsh-hover-spotlight] [data-dsh-aqua-spot]{position:relative;isolation:isolate}',
      // glow 覆盖层:默认 inert,仅辉光开启且悬停时点亮。
      '[data-dsh-aqua-glow]{display:none}',
      'html[data-dsh-hover-spotlight] [data-dsh-aqua-glow]{display:block;position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity 0.3s ease;z-index:-1}',
      'html[data-dsh-hover-spotlight] [data-dsh-aqua-spot][data-spot-on] [data-dsh-aqua-glow]{opacity:1}',
      // 融合的输入框+统计行 spot 是隐形包装,辉光用卡片 24px 圆角。
      'html[data-dsh-hover-spotlight] [data-dsh-inputbar][data-dsh-aqua-spot] [data-dsh-aqua-glow]{border-radius:24px}',
      // 下压:JS 写 perspective+rotate 内联,过渡让按入/回弹都顺滑。
      'html[data-dsh-hover-press] [data-dsh-aqua-spot]{transition:transform 0.1s ease-out}',
    ].join('')
    let cssEl = document.getElementById('dsh-ambient-css')
    if (cssEl === null) {
      cssEl = document.createElement('style')
      cssEl.id = 'dsh-ambient-css'
      document.head.appendChild(cssEl)
    }
    cssEl.textContent = CSS

    // ── 粒子鲸鱼(移植 whale.ts,canvas 引擎) ──
    const WHALE_SVG = '${WHALE_SVG}'
    const GRID = 60
    const UNIT = 0.18
    const LIGHT_X = 4.5
    const LIGHT_Y = 5.5
    const LIGHT_RANGE = 14
    const SHADE_MIN = 0.2
    const SHADE_MAX = 0.4 * 2.79
    const FOLLOW_X = 1.05
    const LOOSE = 1
    const MOUSE_RADIUS = 4.9
    const MOUSE_STRENGTH = 0.8
    const MOUSE_DECAY = 0.2
    const MOUSE_DISTORT = 5
    const FPS = 30
    const WORLD_H = 2 * 18 * Math.tan((50 * Math.PI) / 360)
    function hash(n) {
      const s = Math.sin(n * 12.9898) * 43758.5453
      return s - Math.floor(s) - 0.5
    }
    const mountWhale = (host, dark) => {
      const holder = document.createElement('div')
      holder.setAttribute('data-dsh-ambient-whale', '')
      holder.setAttribute('data-scheme', dark ? 'dark' : 'light')
      const canvas = document.createElement('canvas')
      canvas.setAttribute('aria-hidden', 'true')
      holder.appendChild(canvas)
      host.appendChild(holder)
      const ctx = canvas.getContext('2d')
      if (ctx === null) {
        holder.remove()
        return { setDark: () => {}, dispose: () => {} }
      }
      const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
      const particles = []
      let raf = 0
      let disposed = false
      let startedAt = performance.now()
      let darkMode = dark
      let mouseWorld = { x: 0, y: 0 }
      let dpr = 1
      let scale = 1
      let width = 0
      let height = 0
      const positionHost = () => {
        const phase = document.querySelector('[data-phase]')
        const rect = phase !== null ? phase.getBoundingClientRect() : undefined
        const r = (rect !== undefined && rect.width > 0)
          ? rect
          : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        const size = Math.round(Math.max(220, Math.min(660, window.innerHeight * 0.76, r.width * 0.8)))
        const left = Math.round(r.left + r.width / 2)
        const top = Math.round(r.top + r.height / 2)
        if (holder.style.width !== size + 'px') holder.style.width = size + 'px'
        if (holder.style.height !== size + 'px') holder.style.height = size + 'px'
        if (holder.style.left !== left + 'px') holder.style.left = left + 'px'
        if (holder.style.top !== top + 'px') holder.style.top = top + 'px'
      }
      const resize = () => {
        positionHost()
        const rect = holder.getBoundingClientRect()
        width = Math.max(1, rect.width)
        height = Math.max(1, rect.height)
        dpr = Math.min(window.devicePixelRatio || 1, 1.5)
        canvas.width = Math.max(1, Math.round(width * dpr))
        canvas.height = Math.max(1, Math.round(height * dpr))
        scale = height / WORLD_H
      }
      const sample = (img) => {
        const off = document.createElement('canvas')
        off.width = GRID
        off.height = GRID
        const octx = off.getContext('2d')
        if (octx === null) return
        octx.fillStyle = '#000'
        octx.fillRect(0, 0, GRID, GRID)
        const fit = Math.min(GRID / img.width, GRID / img.height)
        const w = img.width * fit
        const h = img.height * fit
        octx.drawImage(img, (GRID - w) / 2, (GRID - h) / 2, w, h)
        const data = octx.getImageData(0, 0, GRID, GRID).data
        const lum = new Float32Array(GRID * GRID)
        for (let i = 0; i < GRID * GRID; i++) {
          lum[i] = (0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2]) / 255
        }
        const hasBrightNeighbor = (x, y) => {
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if (dx === 0 && dy === 0) continue
              const nx = x + dx
              const ny = y + dy
              if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue
              if (lum[ny * GRID + nx] > 0.2) return true
            }
          }
          return false
        }
        for (let e = 0; e < GRID; e++) {
          for (let n = 0; n < GRID; n++) {
            const a = lum[e * GRID + n]
            if (a <= 0.2 || !hasBrightNeighbor(n, e)) continue
            const x = (n - GRID / 2) * UNIT
            const y = (GRID / 2 - e) * UNIT
            let edge = 0
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue
                const nx = n + dx
                const ny = e + dy
                if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID || lum[ny * GRID + nx] <= 0.2) edge++
              }
            }
            const phi = Math.random() * Math.PI * 2
            const theta = Math.acos(2 * Math.random() - 1)
            const rad = 3 * (0.4 + 0.6 * Math.random())
            particles.push({
              x,
              y,
              opacity: a,
              edge: edge / 8,
              sx: Math.sin(theta) * Math.cos(phi) * rad,
              sy: Math.sin(theta) * Math.sin(phi) * rad,
              sz: Math.cos(theta) * rad * 0.5,
            })
          }
        }
      }
      const draw = (assembly, time) => {
        if (width === 0 || height === 0) resize()
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, width, height)
        ctx.globalCompositeOperation = 'lighter'
        const targetX = mouseWorld.x
        const targetY = mouseWorld.y
        const lightX = LIGHT_X + targetX * FOLLOW_X
        const lightY = LIGHT_Y
        const mouseRadius = MOUSE_RADIUS
        const strength = MOUSE_STRENGTH
        const size = Math.max(1.1, 0.06 * scale * dpr)
        const breathe = 0.15 * Math.sin(0.4 * time)
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i]
          const loose = LOOSE * (0.25 + 0.75 * p.edge) * assembly
          let px = p.x + hash(i) * 0.05 * loose
          let py = p.y + hash(i * 1.37 + 7) * 0.05 * loose
          px += Math.sin(time * 0.5 + i * 0.53) * 0.06 * loose
          py += Math.cos(time * 0.42 + i * 0.71) * 0.06 * loose
          const tail = smoothstep(0.5, 4.5, p.x) * LOOSE * assembly
          py += Math.sin(time * 1.1 - p.x * 0.7) * 0.1 * tail
          px += Math.cos(time * 0.9 - p.x * 0.55) * 0.06 * tail
          px = p.sx + (px - p.sx) * assembly
          py = p.sy + (py - p.sy) * assembly
          if (assembly > 0.8) {
            const mouseEffect = (assembly - 0.8) * 5
            const mx = px - targetX
            const my = py - targetY
            const dist = Math.sqrt(mx * mx + my * my)
            if (dist < mouseRadius && dist > 0.001) {
              const t = 1 - dist / mouseRadius
              const force = t * t * t * mouseEffect * strength
              const angle = Math.sin(i * 0.37 + time * 0.5) * MOUSE_DISTORT
              const ca = Math.cos(angle)
              const sa = Math.sin(angle)
              const ux = mx / dist
              const uy = my / dist
              const rx = ux * ca - uy * sa
              const ry = ux * sa + uy * ca
              px += rx * force * 2
              py += ry * force * 2
            }
          }
          const ldx = px - lightX
          const ldy = py - lightY
          const lit = Math.min(1, Math.max(0, 1 - Math.sqrt(ldx * ldx + ldy * ldy) / LIGHT_RANGE))
          const vLight = SHADE_MIN + SHADE_MAX * lit * lit
          const dist = Math.sqrt(px * px + py * py)
          const glow = smoothstep(8, 0, dist) * 0.3 * assembly
          const baseAlpha = 0.45 + 0.3 * assembly
          const shimmer = Math.sin(time * 1.5 + px * 5 + py * 3) * 0.1 + 0.9
          const alpha = p.opacity * (baseAlpha + glow) * shimmer * Math.min(vLight, 1)
          const br = darkMode ? 0.75 : 0.42
          const bg = darkMode ? 0.8 : 0.44
          const bb = darkMode ? 0.9 : 0.47
          const r = Math.min(255, Math.round((br * assembly + glow * 0.2) * vLight * 255))
          const g = Math.min(255, Math.round((bg * assembly + glow * 0.3) * vLight * 255))
          const b = Math.min(255, Math.round((bb * assembly + glow * 0.5) * vLight * 255))
          if (alpha <= 0.004) continue
          ctx.fillStyle = 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha.toFixed(3) + ')'
          const sx = width / 2 + px * scale - size / 2
          const sy = height / 2 - (py + breathe) * scale - size / 2
          ctx.fillRect(sx, sy, size, size)
        }
        ctx.globalCompositeOperation = 'source-over'
      }
      function smoothstep(a, b, t) {
        const x = Math.min(1, Math.max(0, (t - a) / (b - a)))
        return x * x * (3 - 2 * x)
      }
      let mouseNdc = { x: 0, y: 0 }
      const onMove = (event) => {
        const rect = holder.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return
        mouseNdc = {
          x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
          y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
        }
      }
      window.addEventListener('pointermove', onMove, { passive: true })
      const start = () => {
        if (disposed) return
        let last = performance.now()
        const step = (now) => {
          if (disposed) return
          if (now - last < 1000 / FPS) {
            raf = requestAnimationFrame(step)
            return
          }
          last = now - ((now - last) % (1000 / FPS))
          positionHost()
          const elapsed = (now - startedAt) / 1000
          const raw = Math.min(1, Math.max(0, (elapsed - 0.3) / 2.5))
          const D = 1 - Math.pow(1 - raw, 3)
          const assembly = smoothstep(0, 1, D)
          const targetX = (mouseNdc.x * WORLD_H) / 2
          const targetY = (mouseNdc.y * WORLD_H) / 2
          mouseWorld.x += (targetX - mouseWorld.x) * MOUSE_DECAY
          mouseWorld.y += (targetY - mouseWorld.y) * MOUSE_DECAY
          draw(assembly, elapsed)
          raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)
      }
      resize()
      window.addEventListener('resize', resize)
      const img = new Image()
      img.onload = () => {
        if (disposed) return
        sample(img)
        resize()
        if (reduced) {
          mouseWorld = { x: 0, y: 0 }
          draw(1, 2)
          window.setTimeout(() => {
            if (disposed) return
            resize()
            draw(1, 2)
          }, 600)
        } else {
          start()
        }
      }
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(WHALE_SVG)
      return {
        setDark: (dark) => {
          if (darkMode === dark) return
          darkMode = dark
          holder.setAttribute('data-scheme', dark ? 'dark' : 'light')
          if (reduced && particles.length > 0) draw(1, 2)
        },
        dispose: () => {
          disposed = true
          cancelAnimationFrame(raf)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('resize', resize)
          holder.remove()
        },
      }
    }

    // ── 交互网格(移植 mesh.ts,dot-grid 引擎) ──
    const SPACING = 90
    const REPEL_RADIUS = 140
    const REPEL_FORCE = 30
    const SPRING = 0.05
    const DAMPING = 0.85
    const LINE_GAP = 10
    const MIN_LINE_DIST = 20
    const LINE_COLOR = 'rgba(60, 100, 160, '
    const DOT_COLOR = 'rgba(60, 100, 160, '
    const LINE_ALPHA = 0.1
    const DOT_ALPHA = 0.2
    const mountMesh = (host) => {
      const canvas = document.createElement('canvas')
      canvas.setAttribute('data-dsh-ambient-mesh', '')
      canvas.setAttribute('aria-hidden', 'true')
      host.appendChild(canvas)
      const ctx = canvas.getContext('2d')
      if (ctx === null) {
        canvas.remove()
        return { dispose: () => {} }
      }
      const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
      const coarse = typeof matchMedia !== 'undefined' && matchMedia('(hover: none), (pointer: coarse)').matches
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      let dots = []
      let cols = 0
      let rows = 0
      let w = 0
      let h = 0
      let raf = 0
      let disposed = false
      let idle = false
      let visible = true
      let resizeTimer = 0
      const mouse = { x: NaN, y: NaN }
      const build = () => {
        cols = Math.ceil(w / SPACING) + 1
        rows = Math.ceil(h / SPACING) + 1
        const startX = (w - (cols - 1) * SPACING) / 2
        const startY = (h - (rows - 1) * SPACING) / 2
        dots = []
        for (let ry = 0; ry < rows; ry++) {
          for (let rx = 0; rx < cols; rx++) {
            const x = startX + SPACING * rx
            const y = startY + SPACING * ry
            dots.push({ restX: x, restY: y, x, y, vx: 0, vy: 0 })
          }
        }
      }
      const resize = () => {
        const cw = canvas.clientWidth
        const ch = canvas.clientHeight
        if (cw === w && ch === h) return
        w = cw
        h = ch
        canvas.width = Math.max(1, Math.round(w * dpr))
        canvas.height = Math.max(1, Math.round(h * dpr))
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        window.clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(build, 150)
      }
      resize()
      build()
      const wake = () => {
        if (!idle) return
        idle = false
        if (raf === 0) raf = requestAnimationFrame(frame)
      }
      const onMove = (event) => {
        if (reduced || coarse) return
        mouse.x = event.clientX
        mouse.y = event.clientY
        wake()
      }
      if (!reduced && !coarse) window.addEventListener('pointermove', onMove, { passive: true })
      let last = 0
      const frame = (now) => {
        raf = 0
        if (disposed) return
        if (!visible || now - last < 1000 / FPS) {
          raf = requestAnimationFrame(frame)
          return
        }
        last = now - ((now - last) % (1000 / FPS))
        const cw = canvas.clientWidth
        const ch = canvas.clientHeight
        if (cw !== w || ch !== h) resize()
        ctx.clearRect(0, 0, w, h)
        const mx = mouse.x
        const my = mouse.y
        let maxV = 0
        for (const dot of dots) {
          if (!Number.isNaN(mx) && !Number.isNaN(my)) {
            const dx = dot.x - mx
            const dy = dot.y - my
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist < REPEL_RADIUS && dist > 0.1) {
              const force = (1 - dist / REPEL_RADIUS) * REPEL_FORCE
              const nx = dx / dist
              const ny = dy / dist
              dot.vx += nx * force * 0.1
              dot.vy += ny * force * 0.1
            }
          }
          const sx = dot.restX - dot.x
          const sy = dot.restY - dot.y
          dot.vx += SPRING * sx
          dot.vy += SPRING * sy
          dot.vx *= DAMPING
          dot.vy *= DAMPING
          dot.x += dot.vx
          dot.y += dot.vy
          const v = Math.abs(dot.vx) + Math.abs(dot.vy)
          if (v > maxV) maxV = v
        }
        ctx.strokeStyle = LINE_COLOR + LINE_ALPHA + ')'
        ctx.lineWidth = 0.5
        for (let ry = 0; ry < rows; ry++) {
          for (let rx = 0; rx < cols - 1; rx++) {
            const a = dots[ry * cols + rx]
            const b = dots[ry * cols + rx + 1]
            const dx = b.x - a.x
            const dy = b.y - a.y
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist < MIN_LINE_DIST) continue
            const ux = dx / dist
            const uy = dy / dist
            ctx.beginPath()
            ctx.moveTo(a.x + LINE_GAP * ux, a.y + LINE_GAP * uy)
            ctx.lineTo(b.x - LINE_GAP * ux, b.y - LINE_GAP * uy)
            ctx.stroke()
          }
        }
        for (let ry = 0; ry < rows - 1; ry++) {
          for (let rx = 0; rx < cols; rx++) {
            const a = dots[ry * cols + rx]
            const b = dots[(ry + 1) * cols + rx]
            const dx = b.x - a.x
            const dy = b.y - a.y
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist < MIN_LINE_DIST) continue
            const ux = dx / dist
            const uy = dy / dist
            ctx.beginPath()
            ctx.moveTo(a.x + LINE_GAP * ux, a.y + LINE_GAP * uy)
            ctx.lineTo(b.x - LINE_GAP * ux, b.y - LINE_GAP * uy)
            ctx.stroke()
          }
        }
        ctx.fillStyle = DOT_COLOR + DOT_ALPHA + ')'
        for (const dot of dots) {
          let r = 1.8
          let alpha = DOT_ALPHA
          if (!Number.isNaN(mx) && !Number.isNaN(my)) {
            const dx = dot.x - mx
            const dy = dot.y - my
            const dist = Math.sqrt(dx * dx + dy * dy)
            const near = Math.max(0, 1 - dist / REPEL_RADIUS)
            r = 1.8 + 2 * near
            alpha = DOT_ALPHA + 0.4 * near
          }
          ctx.globalAlpha = alpha
          const size = 2 * r
          ctx.fillRect(dot.x - r, dot.y - r, size, size)
        }
        ctx.globalAlpha = 1
        if (maxV < 0.01) {
          idle = true
        } else {
          raf = requestAnimationFrame(frame)
        }
      }
      if (reduced || coarse) {
        resize()
        ctx.clearRect(0, 0, w, h)
        ctx.strokeStyle = LINE_COLOR + LINE_ALPHA + ')'
        ctx.lineWidth = 0.5
        for (let ry = 0; ry < rows; ry++) {
          for (let rx = 0; rx < cols - 1; rx++) {
            const a = dots[ry * cols + rx]
            const b = dots[ry * cols + rx + 1]
            ctx.beginPath()
            ctx.moveTo(a.x + LINE_GAP, a.y)
            ctx.lineTo(b.x - LINE_GAP, b.y)
            ctx.stroke()
          }
        }
        for (let ry = 0; ry < rows - 1; ry++) {
          for (let rx = 0; rx < cols; rx++) {
            const a = dots[ry * cols + rx]
            const b = dots[(ry + 1) * cols + rx]
            ctx.beginPath()
            ctx.moveTo(a.x, a.y + LINE_GAP)
            ctx.lineTo(b.x, b.y - LINE_GAP)
            ctx.stroke()
          }
        }
        ctx.fillStyle = DOT_COLOR + DOT_ALPHA + ')'
        for (const dot of dots) ctx.fillRect(dot.x - 1.8, dot.y - 1.8, 3.6, 3.6)
      } else {
        raf = requestAnimationFrame(frame)
        const observer = new IntersectionObserver((entries) => {
          visible = entries[0] !== undefined ? entries[0].isIntersecting : true
          if (visible) wake()
        }, { threshold: 0 })
        observer.observe(canvas)
        return {
          dispose: () => {
            disposed = true
            cancelAnimationFrame(raf)
            window.clearTimeout(resizeTimer)
            observer.disconnect()
            window.removeEventListener('pointermove', onMove)
            canvas.remove()
          },
        }
      }
      return {
        dispose: () => {
          disposed = true
          cancelAnimationFrame(raf)
          window.clearTimeout(resizeTimer)
          window.removeEventListener('pointermove', onMove)
          canvas.remove()
        },
      }
    }

    // ── 环境生物(移植 critters.ts,markup + CSS 动画) ──
    const FISH_PATH = '${FISH_PATH}'
    const crittersMarkup = (() => {
      const svg = (critter, viewBox, width, style, body) => {
        return '<svg data-aqua-critter="' + critter + '" viewBox="' + viewBox + '" width="' + width + '" style="' + style + '" aria-hidden="true">' + body + '</svg>'
      }
      const fish = (style, width) => svg('fish', '0 0 23.16 17.04', width, style, '<path d="' + FISH_PATH + '" fill="currentColor"/>')
      const fishLeft = (style, width) => svg('fish-left', '0 0 23.16 17.04', width, style, '<path d="' + FISH_PATH + '" fill="currentColor"/>')
      const bubble = (style, size) => svg('bubble', '0 0 8 8', size, style, '<circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" stroke-width="1"/>')
      const plankton = (style) => svg('plankton', '0 0 3 3', 3, style, '<circle cx="1.5" cy="1.5" r="1.5" fill="currentColor"/>')
      return [
        fish('top:22%;left:58%;animation-duration:9s', 30),
        fishLeft('top:36%;left:10%;animation-duration:14s;animation-delay:-4s', 20),
        fish('top:64%;left:76%;animation-duration:19s;animation-delay:-9s;opacity:0.55', 14),
        bubble('bottom:8%;left:9%;animation-duration:8s', 7),
        bubble('bottom:5%;left:13%;animation-duration:10s;animation-delay:2.5s', 5),
        bubble('bottom:10%;left:17%;animation-duration:9s;animation-delay:5s', 6),
        bubble('bottom:9%;left:82%;animation-duration:11s;animation-delay:1.5s', 8),
        bubble('bottom:6%;left:87%;animation-duration:8s;animation-delay:4s', 5),
        plankton('top:14%;left:42%;animation-delay:-1s'),
        plankton('top:32%;left:70%;animation-delay:-3s'),
        plankton('top:72%;left:18%;animation-delay:-2s'),
        plankton('top:56%;left:86%;animation-delay:-4s'),
      ].join('')
    })()

    // ── 悬停效果:spot 打标 + 辉光/下压控制器
    //    (移植 seam-stamper / spot-core / spotlight.ts) ──
    // 先打标输入栏/统计行 seam(spot 选择器依赖它们),再打 spot 标记。
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
        const glow = spot.querySelector(':scope > [data-dsh-aqua-glow]')
        if (glow !== null) glow.style.removeProperty('background-image')
        easeBack(spot)
      }
      const measure = (spot) => {
        const visual = visualRect(spot)
        const local = glassLocalRect(spot)
        const glow = glowGated() ? ensureGlow(spot) : null
        if (glow !== null) {
          glow.style.left = local.left + 'px'
          glow.style.top = local.top + 'px'
          glow.style.width = local.width + 'px'
          glow.style.height = local.height + 'px'
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
              glow.style.backgroundImage = 'radial-gradient(' + GLOW_RADIUS + 'px at ' + (clientX - visual.left) + 'px ' + (clientY - visual.top) + 'px, var(--dsh-aqua-spot-color, ' + GLOW_FALLBACK + '), transparent 70%)'
            } else {
              glow.style.removeProperty('background-image')
            }
          }
          if (tiltGated() && tiltable(spot)) {
            const dx = Math.min(0.5, Math.max(-0.5, (clientX - visual.left) / visual.width - 0.5))
            const dy = Math.min(0.5, Math.max(-0.5, (clientY - visual.top) / visual.height - 0.5))
            const tiltMax = spot.hasAttribute('data-dsh-trajectory') ? TILT_MAX * 0.5 : TILT_MAX
            spot.style.transformOrigin = (local.left + local.width / 2) + 'px ' + (local.top + local.height / 2) + 'px'
            spot.style.transform = 'perspective(' + TILT_PERSPECTIVE + 'px) rotateX(' + (tiltMax * -2 * dy) + 'rad) rotateY(' + (tiltMax * 2 * dx) + 'rad) scale(1.01)'
            tilted.add(spot)
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

    // ── 容器与效果同步 ──
    let whaleHandle = undefined
    let meshHandle = undefined
    const ensureContainer = () => {
      let el = document.getElementById('dsh-dt-ambient')
      if (el === null) {
        el = document.createElement('div')
        el.id = 'dsh-dt-ambient'
        el.innerHTML = crittersMarkup
        document.body.appendChild(el)
      }
      return el
    }
    const updateSpotColor = () => {
      document.documentElement.style.setProperty('--dsh-aqua-spot-color', isDark() ? 'hsla(216, 90%, 62%, 0.17)' : 'hsla(216, 90%, 45%, 0.16)')
    }
    const sync = () => {
      const el = ensureContainer()
      el.dataset.critters = state.critters ? 'on' : 'off'
      if (state.whale && whaleHandle === undefined) whaleHandle = mountWhale(el, isDark())
      if (!state.whale && whaleHandle !== undefined) {
        whaleHandle.dispose()
        whaleHandle = undefined
      }
      if (state.mesh && meshHandle === undefined) meshHandle = mountMesh(el)
      if (!state.mesh && meshHandle !== undefined) {
        meshHandle.dispose()
        meshHandle = undefined
      }
      updateSpotColor()
      document.documentElement.toggleAttribute('data-dsh-hover-spotlight', state.spotlight)
      document.documentElement.toggleAttribute('data-dsh-hover-press', state.press)
    }
    sync()

    // 主题切换(深浅)时翻转鲸鱼粒子配色,辉光颜色跟随明暗。
    const darkObserver = new MutationObserver(() => {
      if (whaleHandle !== undefined) whaleHandle.setDark(isDark())
      updateSpotColor()
    })
    darkObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    // 自愈:SPA 若清掉了 ambient 容器则重建。
    const healObserver = new MutationObserver(() => {
      if (document.getElementById('dsh-dt-ambient') === null) sync()
    })
    healObserver.observe(document.body, { childList: true })

    // ── 主题设置面板:环境装饰分组开关 ──
    const mountUI = () => {
      if (window.dshDesktop === undefined) return
      const panel = document.querySelector('[data-dsh-theme-panel]')
      if (panel === null) return
      const zh = window.__dshThemeLocale !== 'en'
      const labels = {
        title: zh ? '环境装饰' : 'Ambient decoration',
        whale: zh ? '粒子鲸鱼' : 'Particle whale',
        critters: zh ? '环境生物' : 'Marine life',
        mesh: zh ? '交互网格' : 'Interactive mesh',
        hoverTitle: zh ? '悬停效果' : 'Hover effects',
        spotlight: zh ? '鼠标辉光' : 'Cursor glow',
        press: zh ? '悬停下压' : 'Hover press',
      }
      const MOUNTED = '[data-dsh-decor-controls]'
      const existing = document.querySelector(MOUNTED)
      if (existing !== null) {
        const syncText = (sel, text) => {
          const el = existing.querySelector(sel)
          if (el !== null && el.textContent !== text) el.textContent = text
        }
        syncText('[data-dsh-decor-title]', labels.title)
        syncText('[data-dsh-label-whale]', labels.whale)
        syncText('[data-dsh-label-critters]', labels.critters)
        syncText('[data-dsh-label-mesh]', labels.mesh)
        return
      }
      const control = document.createElement('div')
      control.dataset.dshDecorControls = 'true'
      control.style.cssText = 'flex-direction:column;gap:12px;padding:16px 0;display:flex'
      control.innerHTML =
        '<div style="color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px" data-dsh-decor-title></div>' +
        '<label style="display:flex;align-items:center;gap:10px;cursor:pointer">' +
          '<span class="dsh-switch">' +
            '<input type="checkbox" data-dsh-toggle-whale>' +
            '<span class="track"></span><span class="thumb"></span>' +
          '</span>' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px" data-dsh-label-whale></span>' +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:10px;cursor:pointer">' +
          '<span class="dsh-switch">' +
            '<input type="checkbox" data-dsh-toggle-critters>' +
            '<span class="track"></span><span class="thumb"></span>' +
          '</span>' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px" data-dsh-label-critters></span>' +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:10px;cursor:pointer">' +
          '<span class="dsh-switch">' +
            '<input type="checkbox" data-dsh-toggle-mesh>' +
            '<span class="track"></span><span class="thumb"></span>' +
          '</span>' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px" data-dsh-label-mesh></span>' +
        '</label>' +
        '<style>' +
          '[data-dsh-decor-controls] .dsh-switch { position:relative; width:36px; height:20px; flex:none; }' +
          '[data-dsh-decor-controls] .dsh-switch input { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; z-index:1; }' +
          '[data-dsh-decor-controls] .dsh-switch .track { position:absolute; inset:0; border-radius:999px; background:rgba(128,132,142,0.35); box-shadow:inset 0 0 0 1px rgba(255,255,255,0.08); transition:background 0.15s ease; }' +
          '[data-dsh-decor-controls] .dsh-switch .thumb { position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.35); transition:transform 0.15s ease; }' +
          '[data-dsh-decor-controls] .dsh-switch input:checked ~ .track { background:#4176e6; }' +
          '[data-dsh-decor-controls] .dsh-switch input:checked ~ .thumb { transform:translateX(16px); }' +
        '</style>'
      const titleEl = control.querySelector('[data-dsh-decor-title]')
      if (titleEl !== null) titleEl.textContent = labels.title
      const syncText = (sel, text) => {
        const el = control.querySelector(sel)
        if (el !== null) el.textContent = text
      }
      syncText('[data-dsh-label-whale]', labels.whale)
      syncText('[data-dsh-label-critters]', labels.critters)
      syncText('[data-dsh-label-mesh]', labels.mesh)
      const whaleToggle = control.querySelector('[data-dsh-toggle-whale]')
      const crittersToggle = control.querySelector('[data-dsh-toggle-critters]')
      const meshToggle = control.querySelector('[data-dsh-toggle-mesh]')
      if (whaleToggle === null || crittersToggle === null || meshToggle === null) return
      whaleToggle.checked = state.whale
      crittersToggle.checked = state.critters
      meshToggle.checked = state.mesh
      whaleToggle.addEventListener('change', () => {
        state.whale = whaleToggle.checked
        write(KEYS.whale, state.whale)
        sync()
      })
      crittersToggle.addEventListener('change', () => {
        state.critters = crittersToggle.checked
        write(KEYS.critters, state.critters)
        sync()
      })
      meshToggle.addEventListener('change', () => {
        state.mesh = meshToggle.checked
        write(KEYS.mesh, state.mesh)
        sync()
      })
      const holder = panel.querySelector('[data-dsh-theme-decor-slot]') || panel
      holder.appendChild(control)

      // ── 悬停效果分组(环境装饰之后) ──
      const HOVER_MOUNTED = '[data-dsh-hover-controls]'
      const hoverExisting = document.querySelector(HOVER_MOUNTED)
      if (hoverExisting !== null) {
        const syncHover = (sel, text) => {
          const el = hoverExisting.querySelector(sel)
          if (el !== null && el.textContent !== text) el.textContent = text
        }
        syncHover('[data-dsh-hover-title]', labels.hoverTitle)
        syncHover('[data-dsh-label-spotlight]', labels.spotlight)
        syncHover('[data-dsh-label-press]', labels.press)
        return
      }
      const hoverControl = document.createElement('div')
      hoverControl.dataset.dshHoverControls = 'true'
      hoverControl.style.cssText = 'flex-direction:column;gap:12px;padding:16px 0;display:flex'
      hoverControl.innerHTML =
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
      const hoverTitleEl = hoverControl.querySelector('[data-dsh-hover-title]')
      if (hoverTitleEl !== null) hoverTitleEl.textContent = labels.hoverTitle
      const syncHoverText = (sel, text) => {
        const el = hoverControl.querySelector(sel)
        if (el !== null) el.textContent = text
      }
      syncHoverText('[data-dsh-label-spotlight]', labels.spotlight)
      syncHoverText('[data-dsh-label-press]', labels.press)
      const spotlightToggle = hoverControl.querySelector('[data-dsh-toggle-spotlight]')
      const pressToggle = hoverControl.querySelector('[data-dsh-toggle-press]')
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
      const hoverHolder = panel.querySelector('[data-dsh-theme-hover-slot]') || panel
      hoverHolder.appendChild(hoverControl)
    }
    mountUI()
    const uiObserver = new MutationObserver(mountUI)
    uiObserver.observe(document.body, { childList: true, subtree: true, characterData: true })

    window.__dshAmbientDecor = {
      dispose: () => {
        if (whaleHandle !== undefined) {
          whaleHandle.dispose()
          whaleHandle = undefined
        }
        if (meshHandle !== undefined) {
          meshHandle.dispose()
          meshHandle = undefined
        }
        darkObserver.disconnect()
        healObserver.disconnect()
        uiObserver.disconnect()
        seamObserver.disconnect()
        spotlightDisposer()
        document.documentElement.removeAttribute('data-dsh-hover-spotlight')
        document.documentElement.removeAttribute('data-dsh-hover-press')
        document.documentElement.style.removeProperty('--dsh-aqua-spot-color')
        const el = document.getElementById('dsh-dt-ambient')
        if (el !== null) el.remove()
        const st = document.getElementById('dsh-ambient-css')
        if (st !== null) st.remove()
      },
    }
  })()`
}
