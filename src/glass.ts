/**
 * dsh-desktop glass: translucent window + frosted-glass styling.
 *
 * Platform reality:
 * - Windows: `backgroundMaterial: 'acrylic'` renders true system frosted
 *   glass (it requires a frameless window), so the hosted page background is
 *   made fully transparent to let the acrylic show through.
 * - macOS: `vibrancy: 'under-window'` renders true system frosted glass; the
 *   page background gets the same transparent treatment.
 * - Linux: compositors (niri, sway, GNOME, KWin Wayland…) expose no
 *   window-background blur protocol, so a real desktop-through blur is not
 *   possible. The frosted look is emulated in-page: injected CSS replaces the
 *   root background with a user-adjustable translucent glass tint. The tint
 *   shows whatever is behind the window through a semi-opaque pane, with a
 *   backdrop blur layered on where the compositor supports it.
 */

import type { BrowserWindowConstructorOptions } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface GlassSettings {
  /** 0..1 — background tint opacity on Linux; ignored on Windows/macOS. */
  alpha: number
  /** Forced UI theme for the hosted page; 'system' follows the OS. */
  theme: GlassTheme
}

/** How the hosted page's dark/light theme is chosen. */
export type GlassTheme = 'dark' | 'light' | 'system'

export const OPACITY_LEVELS = [1.0, 0.85, 0.7, 0.55, 0.4] as const
export const DEFAULT_ALPHA = 0.4
export const DEFAULT_THEME: GlassTheme = 'system'
export const THEMES: readonly GlassTheme[] = ['system', 'dark', 'light']

/**
 * Solid deep-blue glass tones for floating chrome (dialogs, dropdown menus,
 * tooltips, input surfaces, and every button fill the SPA paints in neutral
 * gray: elevated, floating, ghost-active, toolbar, primary hover, contrast).
 * The theme's defaults are neutral grays
 * (`--dsw-static-neutral-bluish-*`); these override them with the same
 * blue-tinted family as the window glass so popups read as blue glass layers
 * instead of gray slabs. Surfaces stay opaque (no alpha) for readability over
 * the translucent canvas — only the large canvas layers get the alpha tint.
 * Tooltip backgrounds stay dark in both themes because tooltip text is always
 * white; the light-theme value below is therefore a dark blue, not a pale one.
 */
const SURFACE_DARK: Record<string, string> = {
  '--dsw-alias-bg-layer-2': 'rgb(32, 38, 52)', // dialog panels, pills
  '--dsw-alias-bg-layer-3': 'rgb(39, 46, 62)', // plugin/config cards, config inputs
  '--dsw-alias-bg-module-platform': 'rgb(39, 46, 62)', // appearance selected cube, badges
  '--dsw-specific-menu': 'rgb(39, 46, 62)', // dropdown menus
  '--dsw-alias-tooltip-bg': 'rgb(46, 54, 73)', // tooltips
  '--dsw-specific-input-major': 'rgb(32, 38, 52)', // input buttons, image viewer
  '--dsw-specific-login-input': 'rgb(24, 28, 40)', // login fields
  '--dsw-alias-button-elevated-fill': 'rgb(32, 38, 52)', // "new session" button, rename input
  '--dsw-alias-button-floating-hover': 'rgb(39, 46, 62)', // its hover state
  '--dsw-alias-button-floating-fill': 'rgb(32, 38, 52)', // scroll-to-bottom, drawer handle
  '--dsw-alias-button-ghost-active-fill': 'rgb(39, 46, 62)', // message bubbles, status badges
  '--dsw-alias-button-primary-hover': 'rgb(238, 241, 249)', // primary (white) button hover
  '--dsw-alias-button-tool-bar-fill': 'rgba(52, 65, 91, 0.55)', // toolbar buttons
  '--dsw-alias-button-tool-bar-hover': 'rgba(52, 65, 91, 0.68)',
  '--dsw-alias-button-ghost-active-border': 'rgb(86, 134, 254)', // active ghost border
}

const SURFACE_LIGHT: Record<string, string> = {
  '--dsw-alias-bg-layer-2': 'rgb(238, 241, 249)',
  '--dsw-alias-bg-layer-3': 'rgb(233, 237, 247)',
  '--dsw-alias-bg-module-platform': 'rgb(233, 237, 247)',
  '--dsw-specific-menu': 'rgb(233, 237, 247)',
  '--dsw-alias-tooltip-bg': 'rgb(45, 52, 70)', // dark blue: tooltip text is always white
  '--dsw-specific-input-major': 'rgb(238, 241, 249)',
  '--dsw-specific-login-input': 'rgb(244, 246, 251)',
  '--dsw-alias-button-elevated-fill': 'rgb(238, 241, 249)',
  '--dsw-alias-button-floating-hover': 'rgb(233, 237, 247)',
  '--dsw-alias-button-floating-fill': 'rgb(238, 241, 249)',
  '--dsw-alias-button-ghost-active-fill': 'rgb(233, 237, 247)',
  '--dsw-alias-button-primary-hover': 'rgb(40, 49, 66)', // primary (near-black) button hover
  '--dsw-alias-button-contrast-fill': 'rgb(32, 38, 52)', // was gray rgb(97,102,107); text stays white
  '--dsw-alias-button-tool-bar-fill': 'rgba(47, 61, 92, 0.5)',
  '--dsw-alias-button-tool-bar-hover': 'rgba(47, 61, 92, 0.6)',
  '--dsw-alias-button-ghost-active-border': 'rgb(65, 118, 230)',
}

/** Restrict a number to the inclusive [0, 1] range, defaulting on NaN. */
function clampUnit(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_ALPHA
  return Math.min(1, Math.max(0, value))
}

/** Accept only known theme values, defaulting otherwise. */
function normalizeTheme(value: unknown): GlassTheme {
  return value === 'dark' || value === 'light' || value === 'system' ? value : DEFAULT_THEME
}

/**
 * BrowserWindow options that make the window a translucency carrier.
 * Windows/macOS get their platform frosted-glass effect; Linux gets a
 * transparent frameless window whose page is tinted by injected CSS.
 */
export function glassWindowOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  switch (platform) {
    case 'win32':
      // backgroundMaterial only renders on a frameless window.
      return { backgroundMaterial: 'acrylic', frame: false, transparent: false }
    case 'darwin':
      return { vibrancy: 'under-window', transparent: true }
    default:
      // Linux: transparency is the carrier; the glass tint lives in page CSS.
      return { transparent: true, frame: false }
  }
}

/**
 * CSS injected into the hosted page. On Windows/macOS the system effect is
 * the translucency, so the page must not paint its own opaque background.
 * On Linux the CSS paints a translucent glass tint whose alpha follows the
 * user setting. Returns null when nothing should be injected.
 *
 * The DeepSeek Harness SPA themes its entire UI through CSS custom properties
 * (--dsw-alias-bg-*, --dsw-specific-*), so painting `html, body` alone is
 * hidden behind the app's own opaque containers. The canvas backgrounds must
 * be made translucent by overriding those variables. Dark and light themes
 * define different palettes, so each is tinted with its own glass color.
 * Floating chrome (dialogs, menus, tooltips, inputs) gets solid deep-blue
 * glass tones (see SURFACE_DARK/SURFACE_LIGHT) instead of the theme's gray.
 */
export function glassCss(platform: NodeJS.Platform, alpha: number): string | null {
  if (platform === 'win32' || platform === 'darwin') {
    return 'html, body { background: transparent !important; }'
  }
  // The page stacks two full-window canvas layers (the app frame and the
  // content panel), so the requested alpha is reached by compensating per
  // layer: a_layer = 1 - (1-a)^(1/2). Verified against the composited output.
  const a = 1 - Math.pow(1 - clampUnit(alpha), 1 / 2)
  // Only the large "canvas" surfaces get the translucent glass tint: the app
  // frame, the content panel and the sidebar. Floating chrome (dialogs, menus,
  // tooltips, input surfaces) is painted in solid deep-blue glass tones so it
  // stays readable over the translucent background and is no longer gray.
  const canvasProps = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-specific-sidebar-fill',
  ]
  const tint = (r: number, g: number, b: number): string =>
    `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
  const surfaceCss = (props: Record<string, string>): string =>
    Object.entries(props).map(([key, value]) => `${key}: ${value} !important;`).join(' ')
  const dark = canvasProps.map((p) => `${p}: ${tint(15, 17, 23)} !important;`).join(' ')
  const light = canvasProps.map((p) => `${p}: ${tint(245, 246, 247)} !important;`).join(' ')
  return [
    'body[data-ds-dark-theme] { ' + dark + ' ' + surfaceCss(SURFACE_DARK) + ' }',
    'body:not([data-ds-dark-theme]) { ' + light + ' ' + surfaceCss(SURFACE_LIGHT) + ' }',
    // The canvas itself must be transparent so the window shows whatever is
    // behind it; the glass tint lives in the UI canvas variables above.
    'html, body { background: transparent !important; }',
    // Progressive enhancement: blur the pane's own backdrop where the
    // compositor supports it (some Wayland setups). Harmless elsewhere.
    'body { backdrop-filter: blur(24px) saturate(140%); -webkit-backdrop-filter: blur(24px) saturate(140%); }',
  ].join('\n')
}

const SETTINGS_FILE = 'glass-settings.json'

/** Read persisted glass settings; corrupted or missing files fall back to defaults. */
export function loadGlassSettings(userData: string): GlassSettings {
  try {
    const raw = readFileSync(join(userData, SETTINGS_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && 'alpha' in (parsed as Record<string, unknown>)) {
      const p = parsed as Record<string, unknown>
      return {
        alpha: clampUnit(typeof p.alpha === 'number' ? p.alpha : DEFAULT_ALPHA),
        theme: normalizeTheme(p.theme),
      }
    }
  } catch {
    // Missing or unparsable settings are not worth surfacing; use defaults.
  }
  return { alpha: DEFAULT_ALPHA, theme: DEFAULT_THEME }
}

/** Persist glass settings (best-effort; a failed write must not crash the app). */
export function saveGlassSettings(userData: string, settings: GlassSettings): void {
  try {
    writeFileSync(join(userData, SETTINGS_FILE), JSON.stringify(settings, null, 2), 'utf8')
  } catch {
    // Best-effort persistence only.
  }
}

/**
 * JavaScript that forces the hosted page's theme attribute to match the
 * preference. Mirrors the page's own inline theme bootstrap (colorScheme +
 * data-ds-dark-theme); the glass tint CSS keys off that attribute, so the
 * right glass color follows automatically. With 'system' the OS preference
 * wins, exactly as the unmodified page would decide.
 */
export function themeScript(theme: GlassTheme): string {
  const dark = `(theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches))`
  return `(() => {
    const theme = ${JSON.stringify(theme)}
    const dark = ${dark}
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.body.toggleAttribute('data-ds-dark-theme', dark)
  })()`
}

/**
 * Self-healing glass guard injected into the hosted page. Unlike `insertCSS`
 * (whose rules the SPA's asynchronously-loaded theme plugin can clobber by
 * re-declaring the same custom properties), this writes the tint values as
 * inline styles with `important` priority — the highest authority available
 * to page script — and installs a MutationObserver that re-applies them
 * whenever the SPA touches the theme attribute, the body style or the head.
 * The guard keys the tint color off `data-ds-dark-theme`, so a theme switch
 * (via the tray or inside the app) picks the matching glass color on its own.
 * Only the large canvas surfaces are tinted with the translucent glass; the
 * floating chrome (dialogs, menus, tooltips, input surfaces) is painted in
 * solid deep-blue glass tones so it reads as blue glass instead of gray.
 *
 * Repeated injections (tray opacity/theme changes re-run this script) must
 * replace, not stack: each run first disconnects the observer installed by
 * the previous run. A stale observer would otherwise keep holding the old
 * alpha values and revert every new write, so live adjustments would never
 * take effect. The previous observer handle is parked on a global the next
 * injection can reach; a full page reload resets it together with the JS
 * context, so no cleanup is needed across navigations.
 */
export function glassGuardScript(alpha: number): string {
  const a = 1 - Math.pow(1 - clampUnit(alpha), 1 / 2)
  const make = (r: number, g: number, b: number): Record<string, string> => ({
    '--dsw-alias-bg-base': `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`,
    '--dsw-alias-bg-layer-1': `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`,
    '--dsw-specific-sidebar-fill': `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`,
  })
  return `(() => {
    if (window.__dshGlassGuardObserver) {
      window.__dshGlassGuardObserver.disconnect()
      window.__dshGlassGuardObserver = undefined
    }
    const darkProps = ${JSON.stringify({ ...make(15, 17, 23), ...SURFACE_DARK })}
    const lightProps = ${JSON.stringify({ ...make(245, 246, 247), ...SURFACE_LIGHT })}
    const pick = () => document.body.hasAttribute('data-ds-dark-theme') ? darkProps : lightProps
    const apply = () => {
      const props = pick()
      for (const [k, v] of Object.entries(props)) {
        if (document.body.style.getPropertyValue(k) !== v) {
          document.body.style.setProperty(k, v, 'important')
        }
      }
    }
    apply()
    const obs = new MutationObserver(apply)
    window.__dshGlassGuardObserver = obs
    obs.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme', 'class'] })
    obs.observe(document.head, { childList: true })
    window.addEventListener('load', apply)
  })()`
}

/**
 * Injected UI for the glass tint in the hosted settings page: a background-
 * opacity slider mounted right below the Appearance row (通用设置 → 外观).
 * The SPA renders the settings panel lazily and rebuilds it on every open, so
 * the script watches the DOM and mounts the control whenever the Appearance
 * group appears; an already-mounted control is left alone, and one dropped
 * with a closed panel is re-mounted on the next open. Values flow to the main
 * process through the `window.dshDesktop` preload bridge (setAlpha/getAlpha),
 * which persists the choice and re-applies the glass guard.
 */
export function alphaControlScript(): string {
  return `(() => {
    if (window.__dshAlphaControlObserver) {
      window.__dshAlphaControlObserver.disconnect()
      window.__dshAlphaControlObserver = undefined
    }
    const MOUNTED = '[data-dsh-glass-alpha]'
    const mount = () => {
      if (window.dshDesktop === undefined) return
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode()) !== null) {
        const text = (node.textContent ?? '').trim()
        // The title text of the Appearance row doubles as the locale probe:
        // matching the Chinese label means the UI is Chinese, and vice versa.
        const title = text === '外观' ? '背景透明度' : text === 'Appearance' ? 'Background opacity' : ''
        if (title === '') continue
        const group = node.parentElement?.parentElement
        if (group === undefined || group === null) continue
        const existing = document.querySelector(MOUNTED)
        if (existing !== null) {
          // Already mounted (the SPA swaps locale text in place without
          // rebuilding the row): keep the control, sync its title.
          const titleEl = existing.firstElementChild
          if (titleEl !== null && titleEl.textContent !== title) titleEl.textContent = title
          return
        }
        const control = document.createElement('div')
        control.dataset.dshGlassAlpha = 'true'
        control.style.cssText = 'flex-direction:column;gap:8px;padding:16px 0;display:flex'
        control.innerHTML =
          '<div style="color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px"></div>' +
          '<div style="display:flex;align-items:center;gap:12px">' +
            '<input type="range" min="0.4" max="1" step="0.05" style="flex:1;cursor:pointer;-webkit-appearance:none;appearance:none;height:6px;border-radius:999px;outline:none;background:linear-gradient(90deg,#4176e6 var(--dsh-alpha-fill,40%),rgba(65,118,230,0.22) var(--dsh-alpha-fill,40%));box-shadow:inset 0 0 0 1px rgba(65,118,230,0.25)">' +
            '<span style="color:var(--dsw-alias-label-secondary);font-size:13px;min-width:44px;text-align:right"></span>' +
          '</div>' +
          '<style>' +
            '[data-dsh-glass-alpha] input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #4176e6;box-shadow:0 1px 4px rgba(15,20,35,0.35),0 0 0 3px rgba(65,118,230,0.18);transition:box-shadow 0.15s ease,transform 0.15s ease;cursor:pointer}' +
            '[data-dsh-glass-alpha] input[type=range]:hover::-webkit-slider-thumb{box-shadow:0 1px 6px rgba(15,20,35,0.4),0 0 0 5px rgba(65,118,230,0.22)}' +
            '[data-dsh-glass-alpha] input[type=range]:active::-webkit-slider-thumb{transform:scale(1.1)}' +
            '[data-dsh-glass-alpha] input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #4176e6;box-shadow:0 1px 4px rgba(15,20,35,0.35);cursor:pointer}' +
            '[data-dsh-glass-alpha] input[type=range]::-moz-range-track{height:6px;border-radius:999px;background:linear-gradient(90deg,#4176e6 var(--dsh-alpha-fill,40%),rgba(65,118,230,0.22) var(--dsh-alpha-fill,40%))}' +
          '</style>'
        const titleEl = control.firstElementChild
        if (titleEl !== null) titleEl.textContent = title
        const input = control.querySelector('input')
        const label = control.querySelector('span')
        if (input === null || label === null) return
        const render = (value) => {
          label.textContent = Math.round(value * 100) + '%'
          const pct = ((value - 0.4) / (1 - 0.4)) * 100
          input.style.setProperty('--dsh-alpha-fill', pct.toFixed(1) + '%')
        }
        let raf = 0
        input.addEventListener('input', () => {
          const value = Number(input.value)
          render(value)
          cancelAnimationFrame(raf)
          raf = requestAnimationFrame(() => { window.dshDesktop.setAlpha(value) })
        })
        window.dshDesktop.getAlpha().then((value) => {
          const clamped = Math.min(1, Math.max(0.4, value))
          input.value = String(clamped)
          render(clamped)
        }).catch(() => {})
        // Mount inside the Appearance row (below its cubes) so the control
        // lives and dies with the row instead of lingering as a sibling when
        // the SPA rebuilds the settings panel.
        group.appendChild(control)
        return
      }
    }
    mount()
    const obs = new MutationObserver(mount)
    window.__dshAlphaControlObserver = obs
    // childList: row (re)mounts; characterData: locale switches swap text in
    // place, which must re-sync the mounted control's title.
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
  })()`
}


/**
 * Ambient texture + UI chrome injection for the hosted page. Everything here
 * is independent of the window frame: film grain + brand glow over the whole
 * canvas, slim glass scrollbars, a floating rounded sidebar card, a compact
 * rounded details panel, a translucent icon-only new-session button, an
 * enlarged living brand (wordmark gradient + whale color cycling every 5s)
 * and a slow randomized entrance for the empty-state hero glow.
 *
 * The previous injection is removed first so repeated calls replace instead
 * of stacking; a self-healing observer re-appends the style node and re-applies
 * the brand styling when the SPA re-renders.
 */
export function ambientStyleScript(): string {
  return `(() => {
    const prevStyle = document.querySelector('#dsh-dt-style')
    if (prevStyle !== null) prevStyle.remove()
    if (window.__dshDtStyleObserver) {
      window.__dshDtStyleObserver.disconnect()
      window.__dshDtStyleObserver = undefined
    }

    const style = document.createElement('style')
    style.id = 'dsh-dt-style'
    style.textContent = [
      // Ambient texture: faint film grain (mix-blend overlay keeps it subtle)
      // + a soft brand-blue glow pooling near the top, like light on glass.
      // Both are static fixed layers — deliberately NO animation, because an
      // animated full-canvas layer pegs the renderer at ~100% CPU under
      // software rendering (see hero below).
      'html::after {',
      "  content: '';",
      '  position: fixed; inset: 0;',
      '  z-index: 2147483001;',
      '  pointer-events: none;',
      "  background-image: url(\\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E\\");",
      '  opacity: 0.025;',
      '  mix-blend-mode: overlay;',
      '}',
      'html::before {',
      "  content: '';",
      '  position: fixed; inset: 0;',
      '  z-index: 2147483000;',
      '  pointer-events: none;',
      '  background: radial-gradient(120% 70% at 50% -8%, rgba(65, 118, 230, 0.16), transparent 62%);',
      '}',
      // Slim unobtrusive scrollbars that read as part of the glass theme.
      '*::-webkit-scrollbar { width: 8px; height: 8px; }',
      '*::-webkit-scrollbar-track { background: transparent; }',
      '*::-webkit-scrollbar-thumb { background: rgba(128, 132, 142, 0.38); border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }',
      '*::-webkit-scrollbar-thumb:hover { background: rgba(128, 132, 142, 0.62); border: 2px solid transparent; background-clip: content-box; }',
      '* { scrollbar-width: thin; scrollbar-color: rgba(128, 132, 142, 0.38) transparent; }',
      // Sidebar as a floating glass card: drop the hard divider, round all
      // corners, lift it off the canvas with margin and a soft shadow.
      '[class*=\"_sidebarCol\"] {',
      '  border-right: none !important;',
      '  border-radius: 16px !important;',
      '  margin: 4px 0 8px 8px !important;',
      '  box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.5);',
      '}',
      '[class*=\"_sidebarCol\"] [class*=\"_root\"] {',
      '  border-radius: 12px !important;',
      '}',
      // Details panel (对话 / 轨迹 / Session log): same floating-card look,
      // compact height so it does not butt against the window top edge.
      '[class*=\"_detailsCol\"] {',
      '  border-left: none !important;',
      '  border-radius: 16px !important;',
      '  margin: 16px 8px 8px 0 !important;',
      '  box-shadow: -8px 0 24px -12px rgba(0, 0, 0, 0.35);',
      '  height: 62% !important;',
      '  align-self: start !important;',
      '}',
      '[class*=\"_detailsCol\"] [class*=\"_header\"] {',
      '  height: 40px !important;',
      '}',
      '[class*=\"_detailsCol\"] [class*=\"_tabs\"] {',
      '  margin-top: 0 !important;',
      '}',
      '[class*=\"_detailsCol\"] [class*=\"_tab\"] {',
      '  font-size: 12px !important;',
      '  padding-bottom: 8px !important;',
      '}',
      '[class*=\"_detailsCol\"] [class*=\"_root\"] {',
      '  border-radius: 12px !important;',
      '}',
      // New-session button: translucent glass pill, icon only (label hidden),
      // original rounded-rect shape.
      '[class*=\"_sidebarCol\"] [class*=\"_newSession\"] {',
      '  background: rgba(65, 118, 230, 0.12) !important;',
      '  border: 1px solid rgba(65, 118, 230, 0.4) !important;',
      '  box-shadow: 0 2px 10px -4px rgba(65, 118, 230, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.06) !important;',
      '  height: 30px !important;',
      '  min-height: 30px !important;',
      '  padding: 0 12px !important;',
      '  margin: 0 2px 8px !important;',
      '  border-radius: 12px !important;',
      '  transition: box-shadow 0.18s ease, background 0.18s ease, border-color 0.18s ease !important;',
      '}',
      '[class*=\"_sidebarCol\"] [class*=\"_newSessionLabel\"] {',
      '  display: none !important;',
      '}',
      '[class*=\"_sidebarCol\"] [class*=\"_newSession\"]:hover {',
      '  background: rgba(65, 118, 230, 0.2) !important;',
      '  border-color: rgba(65, 118, 230, 0.6) !important;',
      '  box-shadow: 0 4px 14px -4px rgba(65, 118, 230, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;',
      '}',
      // Expanded brand: taller logo row (75px) and larger wordmark. The
      // collapsed rail keeps its compact 36px strip unchanged.
      '[class*=\"_sidebarCol\"] [class*=\"_root\"]:not([class*=\"_collapsed\"]) [class*=\"_logoRow\"] {',
      '  height: 75px !important;',
      '  margin-bottom: 6px !important;',
      '  padding-top: 6px !important;',
      '  padding-bottom: 6px !important;',
      '}',
      '[class*=\"_sidebarCol\"] [class*=\"_root\"]:not([class*=\"_collapsed\"]) [class*=\"_brand\"] svg {',
      '  width: 260px !important;',
      '  height: auto !important;',
      '}',
      // Empty-state hero glow: slow entrance + gentle randomized idle motion.
      '@keyframes dsh-hero-fade-in {',
      '  from { opacity: 0; transform: translate(-50%, 50%) scale(0.9); }',
      '  to { opacity: 1; transform: translate(-50%, 50%) scale(1); }',
      '}',
      '@keyframes dsh-hero-drift {',
      '  0%, 100% { transform: translate(-50%, 50%) translateY(0); }',
      '  50% { transform: translate(-50%, 50%) translateY(-14px); }',
      '}',
      '@keyframes dsh-hero-breathe {',
      '  0%, 100% { transform: translate(-50%, 50%) scale(1); opacity: 0.85; }',
      '  50% { transform: translate(-50%, 50%) scale(1.06); opacity: 1; }',
      '}',
      '@keyframes dsh-hero-sway {',
      '  0%, 100% { transform: translate(-50%, 50%) rotate(-1.2deg); }',
      '  50% { transform: translate(-50%, 50%) rotate(1.2deg); }',
      '}',
      '[class*=\"_heroGlow\"][data-dsh-hero] {',
      '  animation: dsh-hero-fade-in 1.6s ease-out both;',
      '}',
      '[class*=\"_heroGlow\"][data-dsh-hero=\"drift\"] {',
      '  animation: dsh-hero-fade-in 1.6s ease-out both;',
      '}',
      '[class*=\"_heroGlow\"][data-dsh-hero=\"breathe\"] {',
      '  animation: dsh-hero-fade-in 1.6s ease-out both;',
      '}',
      '[class*=\"_heroGlow\"][data-dsh-hero=\"sway\"] {',
      '  animation: dsh-hero-fade-in 1.6s ease-out both;',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  [class*=\"_heroGlow\"][data-dsh-hero] { animation: dsh-hero-fade-in 0.8s ease-out both !important; }',
      '}',
    ].join('\\n')
    document.head.appendChild(style)

    // Brand colors: whale accent + gradient palette, cycled every 5s.
    const whaleColors = ['#4176e6', '#3b82f6', '#06b6d4', '#10b981', '#6366f1', '#0ea5e9', '#7b5cf0', '#f472b6']
    const gradPalettes = [
      ['#4176e6', '#7b5cf0', '#22d3ee'],
      ['#4176e6', '#06b6d4', '#34d399'],
      ['#6366f1', '#a855f7', '#f472b6'],
      ['#0ea5e9', '#4176e6', '#8b5cf6'],
    ]
    let whaleColor = whaleColors[Math.floor(Math.random() * whaleColors.length)]
    let gradColors = gradPalettes[Math.floor(Math.random() * gradPalettes.length)]
    let lastAppliedGrad = ''
    let lastAppliedWhale = ''

    // One-time structural setup: inject the linearGradient and point letter
    // paths at it. Gradient stops are repainted on each cycle.
    const applyLogoStructure = () => {
      const svg = document.querySelector('[class*=\"_brand\"] svg')
      if (svg === null) return
      if (svg.dataset.dshLogoDone === '1') return
      svg.dataset.dshLogoDone = '1'
      const NS = 'http://www.w3.org/2000/svg'
      const gradId = 'dsh-logo-grad'
      const defs = document.createElementNS(NS, 'defs')
      const grad = document.createElementNS(NS, 'linearGradient')
      grad.id = gradId
      grad.setAttribute('x1', '0')
      grad.setAttribute('y1', '0')
      grad.setAttribute('x2', '1')
      grad.setAttribute('y2', '0')
      defs.appendChild(grad)
      svg.insertBefore(defs, svg.firstChild)
      svg.querySelectorAll('path[fill="currentColor"]').forEach((p) => {
        p.setAttribute('fill', 'url(#' + gradId + ')')
      })
    }

    // Repaint the wordmark gradient and whale rect with current colors.
    const applyLogo = () => {
      const svg = document.querySelector('[class*="_brand"] svg')
      if (svg === null) return
      const gradKey = gradColors.join('|')
      if (gradKey === lastAppliedGrad && whaleColor === lastAppliedWhale) return
      const NS = 'http://www.w3.org/2000/svg'
      let grad = svg.querySelector('linearGradient[id="dsh-logo-grad"]')
      if (grad === null) {
        delete svg.dataset.dshLogoDone
        applyLogoStructure()
        grad = svg.querySelector('linearGradient[id="dsh-logo-grad"]')
        if (grad === null) return
      }
      while (grad.firstChild !== null) grad.removeChild(grad.firstChild)
      gradColors.forEach((c, i) => {
        const stop = document.createElementNS(NS, 'stop')
        stop.setAttribute('offset', String((i * 100) / (gradColors.length - 1)) + '%')
        stop.setAttribute('stop-color', c)
        grad.appendChild(stop)
      })
      svg.querySelectorAll('rect').forEach((r) => {
        if (r.getAttribute('fill') !== whaleColor) r.setAttribute('fill', whaleColor)
      })
      lastAppliedGrad = gradKey
      lastAppliedWhale = whaleColor
    }

        // Collapsed rail fish: repaint with the same whale color (all paths,
    // since a currentColor-only selector stops matching after first paint).
    const applyRailFish = () => {
      const fish = document.querySelector('[class*=\"_railFish\"]')
      if (fish === null) return
      fish.querySelectorAll('path').forEach((p) => {
        if (p.getAttribute('fill') !== whaleColor) p.setAttribute('fill', whaleColor)
      })
    }

    // Every 5s pick fresh whale + gradient colors and repaint whichever
    // brand surface is visible. Timestamp guard dedupes the 1s heartbeat.
    let lastBrandColorChange = 0
    const cycleBrandColors = () => {
      const now = Date.now()
      if (now - lastBrandColorChange < 5000) return
      lastBrandColorChange = now
      whaleColor = whaleColors[Math.floor(Math.random() * whaleColors.length)]
      gradColors = gradPalettes[Math.floor(Math.random() * gradPalettes.length)]
      applyLogo()
      applyRailFish()
    }
    setInterval(cycleBrandColors, 1000)

    // Empty-state hero: pick one idle motion variant at random per launch.
    const applyHero = () => {
      const hero = document.querySelector('[class*=\"_heroGlow\"]')
      if (hero === null) return
      if (hero.dataset.dshHero !== undefined) return
      const variants = ['drift', 'breathe', 'sway']
      hero.dataset.dshHero = variants[Math.floor(Math.random() * variants.length)]
    }

    // Self-heal: re-append style if purged, re-apply brand + hero on
    // re-render. The observer is throttled with requestAnimationFrame so the
    // SPA's frequent DOM churn (typing, scrolling, animations) coalesces into
    // at most one pass per frame instead of a synchronous query per mutation
    // — that was pegging the renderer at 110% CPU.
    let obsScheduled = false
    const obsTick = () => {
      obsScheduled = false
      if (!document.head.contains(style)) {
        if (document.querySelector('#dsh-dt-style') === null) document.head.appendChild(style)
      }
      applyLogoStructure()
      applyLogo()
      applyRailFish()
      applyHero()
    }
    const obs = new MutationObserver(() => {
      if (obsScheduled) return
      obsScheduled = true
      requestAnimationFrame(obsTick)
    })
    window.__dshDtStyleObserver = obs
    obs.observe(document.head, { childList: true })
    obs.observe(document.body, { childList: true, subtree: true })
    applyLogoStructure()
    applyLogo()
    applyRailFish()
    applyHero()
  })()`
}
