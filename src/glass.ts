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
  /** Stored wallpaper file name under userData, or null for none. */
  wallpaper: string | null
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
  '--dsw-specific-input-major': 'rgb(58, 68, 90)', // input buttons, image viewer (brighter)
  '--dsw-specific-login-input': 'rgb(52, 62, 84)', // login fields (brighter)
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
        wallpaper: typeof p.wallpaper === 'string' && p.wallpaper !== '' ? p.wallpaper : null,
      }
    }
  } catch {
    // Missing or unparsable settings are not worth surfacing; use defaults.
  }
  return { alpha: DEFAULT_ALPHA, theme: DEFAULT_THEME, wallpaper: null }
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
    // Floating docks (file panel, terminal dock) sit on the body with a
    // frame-colored underlay behind them (see terminalScript), so both the
    // dock body and its surroundings composite to the same depth as the
    // center column: inside = body + underlay + panel = three a-layers ≈ 0.533,
    // around = body + underlay = two a-layers ≈ 0.398. The dock fill is the
    // per-layer alpha a; the underlay supplies the second layer.
    '--dsw-specific-panel-fill': `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`,
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
      // The alpha slider now lives in the injected Theme Settings panel
      // (主题设置), mounted by themeSettingsScript — not the Appearance row.
      const panel = document.querySelector('[data-dsh-theme-panel]')
      if (panel === null) return
      const zh = window.__dshThemeLocale !== 'en'
      const title = zh ? '背景透明度' : 'Background opacity'
      const existing = document.querySelector(MOUNTED)
      if (existing !== null) {
        // Already mounted (the SPA swaps locale text in place without
        // rebuilding the panel): keep the control, sync its title.
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
          '<div data-dsh-cursor-fx style="flex-direction:column;gap:10px;display:flex;margin-top:8px">' +
            '<div style="color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px">光标特效</div>' +
            '<label style="display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer">' +
              '<input type="checkbox" style="width:15px;height:15px;accent-color:#4176e6;cursor:pointer">' +
              '<span>启用</span>' +
            '</label>' +
            '<div style="display:flex;align-items:center;gap:10px">' +
              '<span style="color:var(--dsw-alias-label-secondary);font-size:13px;min-width:52px">侧边栏</span>' +
              '<select data-dsh-fx-sidebar style="flex:1;background:rgb(39,46,62);color:var(--dsw-alias-label-primary);border:none;border-radius:18px;padding:6px 12px;font-size:13px;cursor:pointer;outline:none">' +
                '<option value="star">星星</option>' +
                '<option value="water">吐水</option>' +
                '<option value="snow">雪花</option>' +
                '<option value="spark">火花</option>' +
                '<option value="none">关闭</option>' +
              '</select>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:10px">' +
              '<span style="color:var(--dsw-alias-label-secondary);font-size:13px;min-width:52px">右侧</span>' +
              '<select data-dsh-fx-center style="flex:1;background:rgb(39,46,62);color:var(--dsw-alias-label-primary);border:none;border-radius:18px;padding:6px 12px;font-size:13px;cursor:pointer;outline:none">' +
                '<option value="water">吐水</option>' +
                '<option value="star">星星</option>' +
                '<option value="snow">雪花</option>' +
                '<option value="spark">火花</option>' +
                '<option value="none">关闭</option>' +
              '</select>' +
            '</div>' +
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
        const input = control.querySelector('input[type=range]')
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
        // Cursor effect toggle + per-pane mode: persisted in localStorage and
        // applied immediately by dispatching a change event the spray script
        // listens to (it survives the settings panel being rebuilt on close).
        const FX_KEY = 'dsh-desktop-cursor-fx'
        const fxToggle = control.querySelector('input[type=checkbox]')
        const fxSidebar = control.querySelector('select[data-dsh-fx-sidebar]')
        const fxCenter = control.querySelector('select[data-dsh-fx-center]')
        if (fxToggle !== null && fxSidebar !== null && fxCenter !== null) {
          let fx = { enabled: true, sidebar: 'star', center: 'water' }
          try {
            const raw = localStorage.getItem(FX_KEY)
            if (raw !== null) {
              const parsed = JSON.parse(raw)
              // Migrate the old single-mode config: 'mixed' → the current
              // defaults, any single mode → both panes.
              if (typeof parsed.mode === 'string' && typeof parsed.sidebar !== 'string') {
                fx = { enabled: parsed.enabled !== false, sidebar: parsed.mode === 'mixed' ? 'star' : parsed.mode, center: parsed.mode === 'mixed' ? 'water' : parsed.mode }
              } else {
                fx = Object.assign(fx, parsed)
              }
            }
          } catch {}
          const applyFx = () => {
            fxToggle.checked = fx.enabled
            fxSidebar.value = fx.sidebar
            fxCenter.value = fx.center
            try { localStorage.setItem(FX_KEY, JSON.stringify(fx)) } catch {}
            window.dispatchEvent(new CustomEvent('dsh-cursor-fx-change', { detail: { enabled: fx.enabled, sidebar: fx.sidebar, center: fx.center } }))
          }
          fxToggle.addEventListener('change', () => { fx.enabled = fxToggle.checked; applyFx() })
          fxSidebar.addEventListener('change', () => { fx.sidebar = fxSidebar.value; applyFx() })
          fxCenter.addEventListener('change', () => { fx.center = fxCenter.value; applyFx() })
          applyFx()
        }
      // Mount inside the Theme Settings panel's dedicated opacity slot so the
      // control lives and dies with the panel instead of lingering when the
      // SPA rebuilds the settings panel.
      const holder = panel.querySelector('[data-dsh-theme-alpha-slot]') || panel
      holder.appendChild(control)
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
 * enlarged living brand (wordmark gradient + whale color cycling, default
 * 10s, configurable in 主题设置).
 * The empty-state hero glow behind the composer is hidden entirely.
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
      // Ambient texture + glow layers are intentionally GONE: a full-canvas
      // fixed layer with mix-blend-mode (film grain) or a radial tint
      // (html::before blue glow pooling near the top) makes the background
      // visibly uneven — the glow only tints the upper half, so the center
      // input/output area reads as "half the background has a different
      // transparency" (verified fullscreen: upper region B-channel +6-9 vs
      // lower). Both also cost render time at fullscreen sizes (software
      // rendering pegs the renderer; see note below). Removed for an even,
      // cheap glass backdrop.
      // Slim unobtrusive scrollbars that read as part of the glass theme.
      '*::-webkit-scrollbar { width: 8px; height: 8px; }',
      '*::-webkit-scrollbar-track { background: transparent; }',
      '*::-webkit-scrollbar-thumb { background: rgba(128, 132, 142, 0.38); border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }',
      '*::-webkit-scrollbar-thumb:hover { background: rgba(128, 132, 142, 0.62); border: 2px solid transparent; background-clip: content-box; }',
      '* { scrollbar-width: thin; scrollbar-color: rgba(128, 132, 142, 0.38) transparent; }',
      // Sidebar as a floating glass card: drop the hard divider, round all
      // corners, lift it off the canvas with margin. NO drop shadow: its
      // rightward spread lands on the center column's left edge across the
      // 4px gap and renders as a dark gradient band on it (same class of
      // artifact as the file panel's shadow).
      '[class*=\"_sidebarCol\"] {',
      '  border-right: none !important;',
      '  border-radius: 16px !important;',
      '  margin: 8px 4px 8px 8px !important;',
      // Kill any drop shadow the web profile's dsh-glass-theme plugin still
      // paints (its GLASS_CSS was forked before this fix): the rightward
      // spread lands on the center column's left edge across the 4px gap.
      '  box-shadow: none !important;',
      '}',
      '[class*=\"_sidebarCol\"] [class*=\"_root\"] {',
      '  border-radius: 12px !important;',
      // Three-way depth match: the sidebar column stacks body + frame +
      // sidebarCol + sidebarRoot (4 translucent layers ≈ 0.637), which renders
      // visibly darker than the center column (3 layers ≈ 0.533). Dropping the
      // inner root's fill leaves body + frame + sidebarCol (3 layers), the
      // same depth as the center column and the file panel (verified on
      // screen). The root's own content keeps its background.
      '  background: transparent !important;',
      '}',
      // Center column (conversation area): same floating glass card as the
      // sidebar — rounded on all four corners, lifted with margin. NO drop
      // shadow: the shadow's leftward spread lands on the sidebar's right
      // edge across the 4px gap and renders as a darker band on it.
      '[class*=\"_centerCol\"] {',
      '  border-radius: 16px !important;',
      '  margin: 8px 8px 8px 0 !important;',
      '  overflow: hidden !important;',
      '}',
      '[class*=\"_centerCol\"] [class*=\"_root\"] {',
      '  border-radius: 12px !important;',
      '}',
      // Details panel (对话 / 轨迹 / Session log): same floating-card look,
      // compact height so it does not butt against the window top edge.
      // NO drop shadow: its leftward spread lands on the center column's
      // right edge and renders as a dark band on it.
      '[class*=\"_detailsCol\"] {',
      '  border-left: none !important;',
      '  border-radius: 16px !important;',
      '  margin: 16px 8px 8px 0 !important;',
      // Same defensive kill as the sidebar: the plugin fork still paints a
      // -8px 0 shadow whose leftward spread lands on the center's right edge.
      '  box-shadow: none !important;',
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
      // Collapsed rail: the icon buttons are 36px but the rail's asymmetric
      // padding (18px left / 10px right) pushed every icon right of center.
      // Symmetric 4px side padding centers the 36px buttons in the 44px rail.
      '[class*=\"_sidebarCol\"] [class*=\"_root\"][class*=\"_collapsed\"] {',
      '  padding: 18px 4px 6px !important;',
      '  align-items: center !important;',
      '}',
      '[class*=\"_sidebarCol\"] [class*=\"_root\"][class*=\"_collapsed\"] [class*=\"_newSession\"] {',
      '  margin: 0 0 8px !important;',
      '}',
      // Empty-state hero glow (blue blurred ellipse behind the composer):
      // hidden entirely — the user wants no glow around the input area.
      '[class*=\"_heroGlow\"] { display: none !important; }',
      // Composer input card: drop its native drop shadow — against the
      // floating glass panes the soft shadow reads as a stray dark outline
      // around the input box and clashes with the flat glass cards.
      '[class*=\"uV2eYG_card\"] { box-shadow: none !important; }',
      // Composer input card fill: DSH paints it with --dsw-specific-input-major
      // (an OPAQUE deep blue-gray), which reads as a solid slab floating on
      // the translucent glass canvas — jarring next to the semi-transparent
      // center column. Repaint it with a slightly deeper frosted glass so the
      // input surface is clearly visible as a distinct frosted pane (alpha
      // 0.35 over the canvas, not the barely-there 0.224), while text/buttons
      // keep their own opaque fills for readability. The frosted (blur)
      // effect applies ONLY inside the card's own border box — the row around
      // it keeps the plain canvas background. The alpha/blur come from the
      // "主界面毛玻璃" slider (主题设置 → 界面毛玻璃), defaulting to the
      // historical values.
      '[class*=\"uV2eYG_card\"] { background-color: var(--dsh-glass-main-bg, rgba(15,17,23,0.35)) !important; backdrop-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%) !important; -webkit-backdrop-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%) !important; }',
      // Task progress strip above the composer (lXshSW_root): DSH paints it
      // with --dsw-specific-tip, an OPAQUE neutral (rgb(53,54,56)) that reads
      // as a solid slab on the glass canvas. Repaint it with the same frosted
      // glass as the input card (alpha 0.35 + blur, inside the strip's own box
      // only) so the two read as one family above the input.
      '[class*=\"lXshSW_root\"] { background: var(--dsh-glass-main-bg, rgba(15,17,23,0.35)) !important; backdrop-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%) !important; -webkit-backdrop-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%) !important; }',
      // User message bubbles in the conversation: DSH paints them with
      // --dsh-specific-bubble, an OPAQUE neutral (rgb(44,44,46)) that reads as
      // a solid slab next to the frosted input card. Repaint them with the
      // same frosted glass as the input card (alpha 0.35 + blur, inside each
      // bubble's own box only) so sent messages match the composer family.
      '[class*=\"_bubble\"] { background-color: var(--dsh-glass-main-bg, rgba(15,17,23,0.35)) !important; backdrop-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%) !important; -webkit-backdrop-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%) !important; }',
      // Composer popup menus (model / access-mode / command pickers, e.g.
      // _7KE1Ra_menu, _3e4SsG_menu): match the access-mode (Full access)
      // menu exactly — an OPAQUE blue-gray rgb(39,46,62). The user compared
      // the two and prefers the Full access look: the frosted translucency
      // (0.35, later 0.5) made these menus read as see-through next to it.
      // No backdrop-filter: the background is opaque, so a blur would be
      // invisible work.
      '[class*=\"_menu\"] { background-color: rgb(39,46,62) !important; }',
      // The whole MAIN surface (everything except the settings panel): the
      // sidebar and the center conversation column get the same frosted glass
      // as the composer (driven by the 主界面毛玻璃 slider), so the whole
      // window reads as one glass family instead of a translucent pane with a
      // few frosted islands. Both classes are stable layout suffixes (one
      // match each); a blanket [class*="_root"] under the center column would
      // hit every message/tool-call block.
      //
      // The SIDEBAR cannot carry the backdrop-filter itself: the hosted
      // settings panel lives in its footer (footArea → settingsArea →
      // VOzbGW_overlay), and a backdrop-filter on the column turns it into
      // the containing block for that fixed overlay, collapsing the settings
      // page to the 268px column width. The blur therefore goes on the
      // sidebar's content elements only (logo row / new-session / session
      // list region), leaving the footer (and the overlay it hosts)
      // untouched; the column still carries the glass background color, so
      // the whole sidebar reads as one surface.
      '[class*=\"_centerCol\"] { background-color: var(--dsh-glass-main-bg, rgba(15,17,23,0.35)) !important; backdrop-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%) !important; -webkit-backdrop-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%) !important; }',
      '[class*=\"_sidebarCol\"] { background-color: var(--dsh-glass-main-bg, rgba(15,17,23,0.35)) !important; }',
      '[class*=\"hHd-Xa_logoRow\"], [class*=\"hHd-Xa_newSession\"], [class*=\"hHd-Xa_regionArea\"] { background-color: var(--dsh-glass-main-bg, rgba(15,17,23,0.35)) !important; backdrop-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%) !important; -webkit-backdrop-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%) !important; }',
      // Hosted settings panel (VOzbGW_panel, tagged data-dsh-settings-panel by
      // themeSettingsScript): DSH paints it with an OPAQUE blue-gray
      // (rgb(32,38,52)). Give the SETTINGS surface its own frosted glass,
      // driven by the 设置界面毛玻璃 slider, so it reads as glass like the
      // main UI instead of a solid slab.
      '[data-dsh-settings-panel] { background-color: var(--dsh-glass-settings-bg, rgba(15,17,23,0.35)) !important; backdrop-filter: blur(var(--dsh-glass-settings-blur, 24px)) saturate(140%) !important; -webkit-backdrop-filter: blur(var(--dsh-glass-settings-blur, 24px)) saturate(140%) !important; }',
      // Tool-call output (Bash etc.) code blocks: DSH fills them with
      // --dsw-alias-markdown-code-block (opaque) and the banner with
      // --dsw-alias-markdown-code-block-banner (opaque). Repaint both with the
      // glass alpha so the popped-out command/output frame matches the panes.
      // The banner sits on the block, so give it one extra translucent layer
      // to stay slightly distinct while still reading as glass.
      '[class*=\"_block_178r4_4\"], [class*=\"_block_10eou_7\"], [class*=\"_block_biesw_7\"], [class*=\"_block_srovd_7\"], [class*=\"_block_s66q0_7\"] { background: var(--dsw-specific-panel-fill, rgba(15,17,23,0.224)) !important; }',
      '[class*=\"_bannerWrap_178r4_21\"] { background-color: var(--dsw-specific-panel-fill, rgba(15,17,23,0.224)) !important; }',
      '[class*=\"_banner_178r4_21\"], [class*=\"_banner_biesw_21\"], [class*=\"_header_10eou_38\"] { background-color: var(--dsw-specific-panel-fill, rgba(15,17,23,0.224)) !important; }',
      // Sidebar list bottom fade: its gradient endpoint follows
      // --dsw-alias-bg-base, which the glass tint makes translucent, so the
      // fade stacks a second translucent layer on the sidebar's own
      // translucent backdrop and renders as a visible darker band above the
      // footer. No fixed color can match the translucent backdrop, so hide
      // the fade entirely — the band is gone, and the sidebar reads clean.
      '[class*=\"_sidebarCol\"] [class*=\"_fade\"] { display: none !important; }',
    ].join('\\n')
    document.head.appendChild(style)

    // Brand colors: whale accent + gradient palette, cycled at the interval
    // configured in 主题设置 (default 10s, see brandCycleMs below).
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
    // Ensure the brand SVG has its gradient infrastructure. The SPA rebuilds
    // the sidebar SVG on collapse/expand, dropping our injected <defs> and
    // reverting letter fills to currentColor - that is why the wordmark
    // flickers away for a frame. Rebuild promptly whenever the structure is
    // missing, even if the dataset flag still says done.
    const ensureLogoStructure = () => {
      const svg = document.querySelector('[class*="_brand"] svg')
      if (svg === null) return
      const NS = 'http://www.w3.org/2000/svg'
      const gradId = 'dsh-logo-grad'
      const grad = svg.querySelector('linearGradient[id="' + gradId + '"]')
      if (grad !== null) {
        // Gradient survives, but the re-render may have reset letter fills
        // back to currentColor; repoint them regardless.
        svg.querySelectorAll('path[fill="currentColor"]').forEach((p) => {
          p.setAttribute('fill', 'url(#' + gradId + ')')
        })
        return
      }
      const defs = document.createElementNS(NS, 'defs')
      const newGrad = document.createElementNS(NS, 'linearGradient')
      newGrad.id = gradId
      newGrad.setAttribute('x1', '0')
      newGrad.setAttribute('y1', '0')
      newGrad.setAttribute('x2', '1')
      newGrad.setAttribute('y2', '0')
      defs.appendChild(newGrad)
      svg.insertBefore(defs, svg.firstChild)
      svg.querySelectorAll('path[fill="currentColor"]').forEach((p) => {
        p.setAttribute('fill', 'url(#' + gradId + ')')
      })
    }

    const applyLogoStructure = ensureLogoStructure

    // Repaint the wordmark gradient and whale rect with current colors.
    const applyLogo = () => {
      const svg = document.querySelector('[class*="_brand"] svg')
      if (svg === null) return
      const NS = 'http://www.w3.org/2000/svg'
      let grad = svg.querySelector('linearGradient[id="dsh-logo-grad"]')
      if (grad === null) {
        // Structure was dropped by a sidebar re-render: rebuild it and force
        // a repaint by clearing the applied-color cache (the new gradient
        // starts with no stops, so an early return would leave it empty).
        lastAppliedGrad = ''
        ensureLogoStructure()
        grad = svg.querySelector('linearGradient[id="dsh-logo-grad"]')
        if (grad === null) return
      }
      const gradKey = gradColors.join('|')
      if (gradKey === lastAppliedGrad && whaleColor === lastAppliedWhale && grad.firstChild !== null) return
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

    // Sidebar operation icons (search, workspace/session row actions): their
    // SVG paths use fill=currentColor, so re-theming the icon color is a
    // single CSS variable update on the sidebar. Text stays untouched — only
    // containers whose direct child is an SVG get the whale color. The
    // workspace section header's three actions (search / view options / add
    // workspace) keep their default color: they are list-scope controls, not
    // session-scope actions, and stay neutral against the tinted row icons.
    const applySidebarIcons = () => {
      const col = document.querySelector('[class*=\"_sidebarCol\"]')
      if (col === null) return
      col.querySelectorAll('button, [class*=\"_iconButton\"], [class*=\"_icon\"]').forEach((el) => {
        // Skip workspace section header actions and any modal/overlay chrome
        // (settings panel, dialogs) that DSH renders inside the sidebar DOM —
        // those keep their native color. Exception: in the collapsed rail the
        // add-workspace button joins the tinted icon set. The rail container
        // carries a stable _rail class (the expanded sidebar keeps a hidden
        // 44px rail root in the DOM without that marker), so detect the
        // collapsed state by ancestry, not by column width (which flickers
        // during the expand/collapse animation). Skipped buttons also have
        // any previously applied tint cleared, so leaving the rail restores
        // the native color instead of keeping the stale brand color.
        if (el.closest('[class*=\"_overlay\"], [class*=\"_modal\"], [class*=\"_panel\"], [class*=\"_dialog\"]') !== null) return
        const inRail = el.closest('[class*=\"_rail\"]') !== null
        const label = el.getAttribute('aria-label') || ''
        const skip = (!inRail && (label.includes('添加工作区') || label.includes('Add workspace'))) || (!inRail && el.closest('[class*=\"_sectionHeader\"]') !== null)
        if (skip) {
          if (el.style.color !== '') el.style.color = ''
          return
        }
        const svg = el.querySelector(':scope > svg')
        if (svg === null || svg.querySelector('path, rect, circle') === null) return
        if (el.style.color !== whaleColor) el.style.color = whaleColor
      })
    }

    // Every brandCycleMs() pick fresh whale + gradient colors and repaint
    // whichever brand surface is visible. The interval is user-configurable
    // (主题设置 → 标题颜色切换时间, persisted in localStorage; default 10s);
    // the timestamp guard dedupes the 1s heartbeat.
    const brandCycleMs = () => {
      try {
        const raw = localStorage.getItem('dsh-desktop-brand-cycle-sec')
        if (raw !== null) {
          const v = JSON.parse(raw)
          if (typeof v === 'number' && v >= 1 && v <= 600) return Math.round(v * 1000)
        }
      } catch {}
      return 10000
    }
    let lastBrandColorChange = 0
    const cycleBrandColors = () => {
      const now = Date.now()
      if (now - lastBrandColorChange < brandCycleMs()) return
      lastBrandColorChange = now
      whaleColor = whaleColors[Math.floor(Math.random() * whaleColors.length)]
      gradColors = gradPalettes[Math.floor(Math.random() * gradPalettes.length)]
      applyLogo()
      applyRailFish()
      applySidebarIcons()
    }
    // Sidebar collapse/expand forces an immediate color change too, so the
    // brand visibly refreshes whenever the rail state toggles.
    const forceBrandColorChange = () => {
      lastBrandColorChange = Date.now()
      whaleColor = whaleColors[Math.floor(Math.random() * whaleColors.length)]
      gradColors = gradPalettes[Math.floor(Math.random() * gradPalettes.length)]
      applyLogo()
      applyRailFish()
      applySidebarIcons()
    }
    setInterval(cycleBrandColors, 1000)
    // Live updates from the settings control: repaint immediately so the new
    // interval is felt at once instead of after the old cycle elapses. The
    // handler is stashed on window so a re-injection replaces, not stacks it.
    if (window.__dshBrandCycleHandler) {
      window.removeEventListener('dsh-brand-cycle-change', window.__dshBrandCycleHandler)
    }
    const onBrandCycleChange = () => {
      lastBrandColorChange = 0
      cycleBrandColors()
    }
    window.__dshBrandCycleHandler = onBrandCycleChange
    window.addEventListener('dsh-brand-cycle-change', onBrandCycleChange)
    // Tracks the previous sidebar rail state so toggles are detected once.
    let lastRailPresent = document.querySelector('[class*="_railFish"]') !== null

    // Self-heal: re-append style if purged, re-apply brand on
    // re-render. The observer is throttled with requestAnimationFrame so the
    // SPA's frequent DOM churn (typing, scrolling, animations) coalesces into
    // at most one pass per frame instead of a synchronous query per mutation
    // — that was pegging the renderer at 110% CPU.
    // The composer's mode/model selector buttons carry native title
    // tooltips the user does not want; strip them whenever the SPA
    // re-renders (React re-applies the attribute on re-render).
    const stripComposerTitles = () => {
      document.querySelectorAll('[class*="cubgiG_seat"], [class*="_7KE1Ra_trigger"]').forEach((el) => {
        if (el.hasAttribute('title')) el.removeAttribute('title')
      })
    }
    let obsScheduled = false
    const obsTick = () => {
      obsScheduled = false
      if (!document.head.contains(style)) {
        if (document.querySelector('#dsh-dt-style') === null) document.head.appendChild(style)
      }
      applyLogoStructure()
      applyLogo()
      applyRailFish()
      applySidebarIcons()
      stripComposerTitles()
    }
    const obs = new MutationObserver(() => {
      // Brand (re)appearance is time-critical: rebuild its gradient structure
      // synchronously so collapse/expand never leaves the wordmark invisible
      // for even one frame. Everything else stays rAF-throttled.
      const brandSvg = document.querySelector('[class*="_brand"] svg')
      if (brandSvg !== null && brandSvg.querySelector('linearGradient[id="dsh-logo-grad"]') === null) {
        ensureLogoStructure()
        lastAppliedGrad = ''
        applyLogo()
      }
      // Collapse/expand flips between brand (open) and rail fish (closed);
      // each toggle forces an immediate brand color change.
      const railPresent = document.querySelector('[class*="_railFish"]') !== null
      if (railPresent !== lastRailPresent) {
        lastRailPresent = railPresent
        forceBrandColorChange()
      }
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
    applySidebarIcons()
    stripComposerTitles()
  })()`
}

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
      const rect = document.querySelector('[class*="_brand"] svg rect')
      if (rect !== null) {
        const f = rect.getAttribute('fill')
        if (f !== null && f !== 'currentColor') return f
      }
      return WHALES[Math.floor(Math.random() * WHALES.length)]
    }

    const triggerZone = (x, y) => {
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
    const MAX_DROPS = 160
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
              toast('备份完成 ✓\n' + res.backupDir)
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
    const obs = new MutationObserver(attach)
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

export function terminalScript(): string {
  return `(() => {
    if (window.__dshTerminal) {
      window.__dshTerminal.dispose()
      window.__dshTerminal = undefined
    }
    if (typeof window.dshDesktop === 'undefined' || !window.dshDesktop.terminal || !window.dshDesktop.fs) return

    // ── Top title bar: slimmer + centered heading ──
    // The conversation column's <header> (session title + tabs) is 76px tall
    // with a left-aligned title. Slim it down and centre the title cluster:
    // the cluster is taken out of flow and centred on the row, while the
    // right-side utilities (Session log etc.) are pushed to the edge.
    const topbarStyle = document.createElement('style')
    topbarStyle.id = 'dsh-topbar-style'
    topbarStyle.textContent = [
      '[class*="_centerCol"] header { height: 64px !important; padding: 2px 0 0 !important; }',
      '[class*="_centerCol"] header [class*="_titleRow"] { position: relative !important; height: 30px !important; padding: 0 !important; }',
      '[class*="_centerCol"] header [class*="_titleCluster"] { position: absolute !important; left: 50% !important; transform: translateX(-50%) !important; width: auto !important; flex: none !important; }',
      '[class*="_centerCol"] header [class*="_headerUtilities"] { margin-left: auto !important; }',
      '[class*="_centerCol"] header [class*="_tabs"] { height: 26px !important; }',
    ].join(' ')
    document.head.appendChild(topbarStyle)
    // Session log: move it from the top-right to the sidebar footer, right
    // beside the Settings button (same row, just right of it). The button
    // only exists while a session is open, so a MutationObserver keeps
    // moving it whenever it appears (React rebuilds it on session switches).
    // It is NOT re-parented (React would rebuild the original, leaving two
    // copies); it is re-positioned with fixed CSS anchored to the footer's
    // Settings trigger.
    const moveSessionLog = () => {
      const sessBtn = Array.from(document.querySelectorAll('button')).find((b) => /session log/i.test((b.title || '') + (b.textContent || '')))
      const footArea = document.querySelector('[class*="_footArea"]')
      if (sessBtn === undefined || footArea === null) return false
      // Sidebar collapsed: the footer shrinks to a rail. Only the Session
      // log button hides (the Settings icon and the memory-panel button
      // stay as-is). The Settings trigger shrinks to its rail size (36px)
      // so it does not overflow the 44px rail.
      const col = document.querySelector('[class*="_sidebarCol"]')
      const tg = footArea.querySelector('[class*="_trigger"]') || footArea.querySelector('button')
      if (col !== null && col.getBoundingClientRect().width < 100) {
        sessBtn.style.visibility = 'hidden'
        if (tg !== null) tg.style.setProperty('width', '36px', 'important')
        return true
      }
      sessBtn.style.visibility = 'visible'
      if (tg !== null) tg.style.setProperty('width', '126px', 'important')
      // Shrink the footer's Settings trigger so the Session log button can
      // sit in the same row, right beside it. (Injected once.)
      if (sessBtn.dataset.dshMoved !== '1') {
        sessBtn.dataset.dshMoved = '1'
        if (document.getElementById('dsh-sesslog-style') === null) {
          const footStyle = document.createElement('style')
          footStyle.id = 'dsh-sesslog-style'
          footStyle.textContent = [
            // Settings trigger: fixed 126px icon-only row at its original
            // left spot; the Session log icon sits just right of it.
            '[class*="_footArea"] [class*="_settingsArea"] { display: flex !important; align-items: center !important; box-sizing: border-box !important; }',
            '[class*="_footArea"] [class*="_settingsArea"] [class*="_trigger"] { width: 126px !important; min-width: 0 !important; padding: 6px 8px !important; margin-right: 0 !important; justify-content: flex-start !important; }',
            '[class*="_footArea"] [class*="_settingsArea"] [class*="_trigger"] span { display: none !important; }',
            // Icon-only Session log button: hide the label, keep the glyph.
            '[class*="_sessionLogButton"] > span { display: none !important; }',
            '[class*="_sessionLogButton"] { min-width: 0 !important; padding: 6px 8px !important; }',
          ].join(' ')
          document.head.appendChild(footStyle)
        }
      }
      // Re-anchor on every call (sidebar resize/collapse, session switches):
      // fixed positioning is relative to the viewport, so the offset must be
      // recomputed from the Settings trigger's CURRENT position to follow it.
      // The Settings trigger fills the row; the Session log icon sits just
      // right of it (the settingsArea keeps a 40px right padding for it).
      const setBtn = footArea.querySelector('[class*="_trigger"]') || footArea.querySelector('button')
      const sr = setBtn.getBoundingClientRect()
      sessBtn.style.position = 'fixed'
      sessBtn.style.top = Math.round(sr.top) + 'px'
      sessBtn.style.left = Math.round(sr.right + 8) + 'px'
      sessBtn.style.zIndex = '9999'
      sessBtn.style.background = 'transparent'
      return true
    }
    moveSessionLog()
    const sessObs = new MutationObserver(() => { moveSessionLog(); watchSessLog() })
    sessObs.observe(document.body, { childList: true, subtree: true })
    // Collapsing the sidebar slides the footer off-screen; the Session log
    // button must hide along with it. Class/style mutations can miss the
    // width-only collapse animation, so observe the sidebar's size.
    let sessResizeObs = null
    let sessWatched = null
    const watchSessLog = () => {
      const col = document.querySelector('[class*="_sidebarCol"]')
      if (col === null) return
      if (sessResizeObs !== null && sessWatched === col) return
      if (sessResizeObs !== null) sessResizeObs.disconnect()
      sessWatched = col
      sessResizeObs = new ResizeObserver(() => { moveSessionLog() })
      sessResizeObs.observe(col)
    }
    watchSessLog()

    // ── Theme: DSH design tokens, dark flag = body[data-ds-dark-theme] ──
    // Read from BODY: the glass tint injects its (semi-transparent) token
    // overrides onto body, so reading documentElement would miss them and
    // fall back to an opaque color that kills the frosted-glass effect.
    const readToken = (name, fallback) => {
      const v = getComputedStyle(document.body).getPropertyValue(name).trim()
      return v !== '' ? v : fallback
    }
    const ANSI_DARK = { black:'#282c34', red:'#e06c75', green:'#98c379', yellow:'#e5c07b', blue:'#61afef', magenta:'#c678dd', cyan:'#56b6c2', white:'#abb2bf', brightBlack:'#5c6370', brightRed:'#e06c75', brightGreen:'#98c379', brightYellow:'#e5c07b', brightBlue:'#61afef', brightMagenta:'#c678dd', brightCyan:'#56b6c2', brightWhite:'#ffffff' }
    const ANSI_LIGHT = { black:'#383a42', red:'#e45649', green:'#50a14f', yellow:'#c18401', blue:'#0184bc', magenta:'#a626a4', cyan:'#0997b3', white:'#a0a1a7', brightBlack:'#4f525e', brightRed:'#e45649', brightGreen:'#50a14f', brightYellow:'#c18401', brightBlue:'#0184bc', brightMagenta:'#a626a4', brightCyan:'#0997b3', brightWhite:'#fafafa' }
    const xtermTheme = () => {
      const dark = document.body.hasAttribute('data-ds-dark-theme')
      const bg = readToken('--dsw-alias-bg-base', dark ? '#111114' : '#ffffff')
      const fg = readToken('--dsw-alias-label-primary', dark ? '#e6e6e6' : '#1a1a1a')
      return Object.assign({ background: bg, foreground: fg, cursor: fg, cursorAccent: bg, selectionBackground: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)' }, dark ? ANSI_DARK : ANSI_LIGHT)
    }

    // ── Font settings (localStorage-persisted, like better-sidebar's prefs) ──
    const FONT_KEY = 'dsh-desktop-terminal-fonts'
    // Nerd Font first: the starship prompt (and shells in general) render
    // powerline separators / OS / branch glyphs that plain monospace lacks.
    let fonts = { family: 'JetBrainsMono Nerd Font, JetBrainsMonoNL Nerd Font, monospace', size: 13 }
    try {
      const saved = JSON.parse(localStorage.getItem(FONT_KEY) || 'null')
      // Only the size is restored; the previously persisted family was the old
      // non-Nerd default and must never come back (missing glyphs).
      if (saved && typeof saved.size === 'number' && saved.size >= 8 && saved.size <= 32) fonts.size = saved.size
    } catch {}

    const mkBtn = (label, title, css) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.innerHTML = label
      if (title !== undefined) b.title = title
      b.style.cssText = css
      return b
    }
    // Icon buttons: transparent like DSH's own icon buttons (no dark ring /
    // border), with the same light hover wash. NO tooltip of any kind.
    const btnCss = 'position:fixed;width:34px;height:34px;border-radius:9px;border:none;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:9999'
    const hoverWash = (btn) => {
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.08)' })
      btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent' })
    }
    const TERM_ICON = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.5-2 1.5M8.5 9.5h3"/></svg>'
    const FILES_ICON = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5H12A1.5 1.5 0 0 1 13.5 6v5A1.5 1.5 0 0 1 12 12.5H3.5A1.5 1.5 0 0 1 2 11z"/></svg>'
    // Terminal toggle stays at the BOTTOM-LEFT, just right of the sidebar.
    // The files toggle returns to the TOP-RIGHT: the Session Log button that
    // used to live there is now moved to the sidebar footer, so the corner
    // is free again. Both are hidden while the terminal dock is open (it
    // has its own collapse button).
    const measureSidebarRight = () => {
      const side = document.querySelector('[class*="_sidebarCol"]') || document.querySelector('[class*="_sidebar"], [class*="_sideNav"], [class*="_rail"], [class*="_navRail"]')
      if (side === null) return 280
      return Math.round(side.getBoundingClientRect().right)
    }
    let sidebarRight = measureSidebarRight()
    const btnTerm = mkBtn(TERM_ICON, undefined, btnCss + ';bottom:8px;left:' + (sidebarRight + 8) + 'px;top:auto;right:auto')
    const btnFiles = mkBtn(FILES_ICON, undefined, btnCss + ';top:8px;right:8px')
    document.body.append(btnTerm, btnFiles)
    hoverWash(btnTerm)
    hoverWash(btnFiles)
    // The sidebar collapses to a 48px rail; the terminal dock + its toggle
    // anchor to the sidebar's right edge, so they must re-measure whenever
    // the sidebar changes size (collapse/expand, project switch rebuilds).
    const applyAnchors = () => {
      btnTerm.style.left = (sidebarRight + 8) + 'px'
      termDock.style.left = sidebarRight + 'px'
    }
    let anchorScheduled = false
    const sidebarObs = new MutationObserver(() => {
      if (anchorScheduled) return
      anchorScheduled = true
      requestAnimationFrame(() => {
        anchorScheduled = false
        const r = measureSidebarRight()
        if (r !== sidebarRight) {
          sidebarRight = r
          applyAnchors()
        }
      })
    })
    sidebarObs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    // ResizeObserver on the sidebar column is the reliable signal: the
    // expand/collapse animation may only change layout (width), not the DOM,
    // so class/style mutations can miss it. The observer target must be
    // re-attached whenever the SPA rebuilds the sidebar node.
    let sidebarResizeObs = null
    let watchedSidebar = null
    const watchSidebarSize = (side) => {
      if (side === null) return
      if (sidebarResizeObs !== null && watchedSidebar === side) return
      if (sidebarResizeObs !== null) sidebarResizeObs.disconnect()
      watchedSidebar = side
      sidebarResizeObs = new ResizeObserver(() => {
        const r = measureSidebarRight()
        if (r !== sidebarRight) {
          sidebarRight = r
          applyAnchors()
        }
      })
      sidebarResizeObs.observe(side)
    }
    watchSidebarSize(document.querySelector('[class*="_sidebarCol"]'))
    const sidebarRebuildObs = new MutationObserver(() => {
      const side = document.querySelector('[class*="_sidebarCol"]')
      if (side !== null && side !== watchedSidebar) watchSidebarSize(side)
    })
    sidebarRebuildObs.observe(document.body, { childList: true, subtree: true })

    // ── Terminal dock (bottom bar right of the conversation sidebar) ──
    const DOCK_H = 340
    // Underlay for the terminal dock: a frame-colored layer behind the dock
    // (z-index 9997, one below the dock). It makes the dock composite like the
    // center column: inside = body + underlay + dock (three a-layers ≈ 0.533),
    // around = body + underlay (two a-layers ≈ 0.398). Without it the dock's
    // translucent fill over bare body would read lighter than the panes.
    const termUnderlay = document.createElement('div')
    termUnderlay.id = 'dsh-term-underlay'
    termUnderlay.style.cssText = [
      'position:fixed', 'left:' + sidebarRight + 'px', 'right:0', 'bottom:0', 'height:' + DOCK_H + 'px', 'z-index:9997',
      'display:none', 'background:var(--dsw-alias-bg-layer-1, rgba(15,17,23,0.224))',
    ].join(';')
    document.body.appendChild(termUnderlay)
    const termDock = document.createElement('div')
    termDock.id = 'dsh-terminal-dock'
    termDock.style.cssText = [
      'position:fixed', 'left:' + sidebarRight + 'px', 'right:0', 'bottom:0', 'height:' + DOCK_H + 'px', 'z-index:9998',
      'display:none', 'background:var(--dsh-glass-main-bg, rgba(15,17,23,0.35))', 'box-sizing:border-box',
      // Frosted like the rest of the main surface: the 主界面毛玻璃 slider
      // controls alpha, the blur rides the same variable as the composer.
      'backdrop-filter:blur(var(--dsh-glass-main-blur, 24px)) saturate(140%)',
      '-webkit-backdrop-filter:blur(var(--dsh-glass-main-blur, 24px)) saturate(140%)',
      'border-top:1px solid rgba(65,118,230,0.22)',
      'flex-direction:column', 'font-size:13px',
    ].join(';')
    document.body.appendChild(termDock)

    const termOpen = () => {
      termDock.style.display = 'flex'
      termUnderlay.style.display = 'block'
      // Only the terminal toggle hides while the dock is open (it sits at the
      // bottom-left, inside the dock's area, and the dock has its own
      // collapse button). The files toggle stays visible top-right — the
      // dock never reaches that corner.
      btnTerm.style.display = 'none'
      // Keep the LEFT sidebar completely untouched: only the right content
      // column (which holds the message stream AND the input bar) shrinks by
      // the dock height, so the input bar moves up above the dock while the
      // sidebar keeps its full height, layout and scroll position.
      const center = document.querySelector('[class*="_centerCol"]')
      if (center !== null) center.style.height = 'calc(100vh - ' + DOCK_H + 'px)'
      if (tabs.length === 0) {
        // Restore this project's saved terminal set (names + directories);
        // a fresh project starts with a single default shell.
        currentProjectKey = getProjectKey()
        loadProjectState()
      } else if (activeTabId !== null) {
        activateTab(activeTabId)
      }
    }
    const termClose = () => {
      termDock.style.display = 'none'
      termUnderlay.style.display = 'none'
      btnTerm.style.display = 'flex'
      const center = document.querySelector('[class*="_centerCol"]')
      if (center !== null) center.style.height = ''
      syncFilesBottom()
    }

    const toolbar = document.createElement('div')
    toolbar.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 6px;flex:none;border-bottom:1px solid rgba(255,255,255,0.06)'
    const tabStrip = document.createElement('div')
    tabStrip.style.cssText = 'display:flex;gap:2px;flex:1;overflow-x:auto;min-width:0;align-items:center'
    const btnAdd = mkBtn('+', undefined, 'border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:14px;padding:2px 8px;border-radius:6px;flex:none')
    const btnCollapse = mkBtn('⌄', undefined, 'border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;padding:2px 8px;border-radius:6px;flex:none')
    // The add button lives INSIDE the strip (it is the insertBefore anchor
    // for new tabs); appending it to the toolbar would make every
    // tabStrip.insertBefore(tabBtn, btnAdd) throw NotFoundError. The collapse
    // toggle goes INSIDE the strip too, right after the add button, so it
    // hugs "+" (a flex:1 strip would otherwise push it to the far right).
    tabStrip.appendChild(btnAdd)
    tabStrip.appendChild(btnCollapse)
    toolbar.append(tabStrip)
    termDock.appendChild(toolbar)

    // ── Font size: Ctrl + mouse wheel (no settings UI) ──
    // The font-settings icon is gone; the size is adjusted directly in the
    // terminal with Ctrl+wheel (8..32px), applied to every tab and persisted.
    const bumpFontSize = (delta) => {
      const size = Math.min(32, Math.max(8, fonts.size + delta))
      if (size === fonts.size) return
      fonts.size = size
      try { localStorage.setItem(FONT_KEY, JSON.stringify(fonts)) } catch {}
      for (const tab of tabs) {
        if (!tab.term) continue
        tab.term.options.fontSize = size
        tab.term.refresh(0, tab.term.rows - 1)
        fitTab(tab)
      }
    }
    const wheelFontHandler = (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      bumpFontSize(e.deltaY < 0 ? 1 : -1)
    }
    // Tab cycling only works while a TAB LABEL has focus: pressing Tab on a
    // label switches to the next terminal (Shift+Tab goes back) and keeps
    // focus on the next label for repeated cycling. Inside the terminal,
    // Tab stays the shell's normal completion key.
    const tabKeyNav = (e, tab) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return
      if (tabs.length < 2) return
      e.preventDefault()
      const idx = tabs.findIndex((t) => t.id === tab.id)
      const delta = e.shiftKey ? -1 : 1
      const next = tabs[(idx + delta + tabs.length) % tabs.length]
      activateTab(next.id)
      if (next.btn !== null) next.btn.focus()
    }

    const dockBody = document.createElement('div')
    dockBody.style.cssText = 'flex:1;min-height:0;position:relative;display:flex'
    termDock.appendChild(dockBody)

    // ── Terminal tabs ──
    const tabs = []
    let counter = 1
    let activeTabId = null

    // ── Per-project terminal state (main-process file, survives launches) ──
    // Each PROJECT (the currently selected session in the sidebar) keeps its
    // own terminal set: names, working directories, active tab. Switching
    // sessions swaps the dock's tabs to that project's set. Persisted
    // through the preload state bridge (NOT localStorage — its origin is the
    // dsh web URL, whose port changes every launch).
    let currentProjectKey = 'default'
    const getProjectKey = () => {
      const sel = document.querySelector('[class*="YDXeBa_selected"], [aria-selected="true"]')
      if (sel === null) return 'default'
      const text = (sel.textContent || '').trim()
      // The row text carries a trailing age ("Fupanla16小时"); strip it so
      // the key stays stable as time passes. NOTE: double backslashes — this
      // script is delivered as a template string, and a single \\s would be
      // evaluated to "s" by the JS string escape rules.
      const key = text.replace(/\\s*\\d+(秒|分钟|小时|天|周|月|年)?\\s*$/, '')
      return key !== '' ? key : 'default'
    }
    // Serialized state writes: concurrent get→set cycles could otherwise
    // overwrite each other (one read snapshot missing the other's update).
    // The tab snapshot is taken SYNCHRONOUSLY because swapTerminals clears
    // tabs right after saving.
    let stateWriteChain = Promise.resolve()
    const saveStateFor = (key) => {
      if (!window.dshDesktop.state) return
      // The id is saved too: restoring a tab under a FRESH id would spawn a
      // brand-new pty (empty shell) instead of re-attaching the project's
      // still-alive one with its transcript and working directory.
      const snapshot = tabs.map((t) => ({ id: t.id, label: t.label, cwd: t.cwd }))
      const active = activeTabId
      stateWriteChain = stateWriteChain.then(() => window.dshDesktop.state.get()).then((all) => {
        const base = all !== null && typeof all === 'object' ? all : {}
        base[key] = { tabs: snapshot, active }
        return window.dshDesktop.state.set(base)
      }).catch(() => {})
    }
    const saveTermState = () => { saveStateFor(currentProjectKey) }
    // A restore is async; fast back-and-forth switches can interleave their
    // get() responses. A monotonic token keeps only the LATEST switch's
    // restore from touching the dock (stale ones are dropped).
    let loadSeq = 0
    const loadProjectState = () => {
      if (!window.dshDesktop.state) { addTab(); return }
      const seq = ++loadSeq
      window.dshDesktop.state.get().then((all) => {
        if (seq !== loadSeq) return
        const saved = all !== null && typeof all === 'object' ? all[currentProjectKey] : undefined
        if (saved !== undefined && Array.isArray(saved.tabs) && saved.tabs.length > 0) {
          for (const item of saved.tabs) {
            if (item !== null && typeof item === 'object') addTab(item.label, item.cwd, typeof item.id === 'string' ? item.id : undefined)
            else addTab()
          }
          // The saved active tab id maps 1:1 onto the restored tabs (ids are
          // persisted now); older snapshots have no id and get a fallback to
          // the first tab instead of leaving every terminal unopened.
          const active = typeof saved.active === 'string' ? saved.active : null
          const target = active !== null && tabs.some((t) => t.id === active) ? active : (tabs.length > 0 ? tabs[0].id : null)
          if (target !== null) activateTab(target)
        } else {
          addTab()
        }
      }).catch(() => { if (seq === loadSeq) addTab() })
    }
    // A session switch swaps the dock's terminal set to that project's tabs.
    // The ptys are deliberately NOT closed: a project's shells must stay
    // alive (running command, cwd, scrollback) so switching back re-attaches
    // to the SAME process and replays its transcript. Only the DOM/xterm is
    // torn down; the main-process registry keeps each tab's pty until the
    // tab is explicitly closed (×) or the app quits.
    const swapTerminals = (newKey) => {
      if (newKey === currentProjectKey) return
      const oldKey = currentProjectKey
      saveStateFor(oldKey)
      currentProjectKey = newKey
      // The file browser follows the project: a session switch snaps an open
      // panel to the NEW session's workspace directory (with a fresh forward
      // stack so › cannot jump into the previous project's folders).
      if (filesPanel.style.display === 'flex') openAtWorkspace()
      // Dock closed: just remember the new project; opening the dock loads it.
      if (termDock.style.display !== 'flex') return
      // Tear down every current tab's UI WITHOUT closeTab (whose pty kill
      // would also destroy the shell we need to re-attach later).
      for (const tab of [...tabs]) {
        if (tab.resizeObs !== null) tab.resizeObs.disconnect()
        if (tab.term !== null) { try { tab.term.dispose() } catch {} }
        tab.btn.remove()
        tab.host.remove()
      }
      tabs.length = 0
      activeTabId = null
      loadProjectState()
    }

    const mkTabBtn = (tab) => {
      const b = mkBtn('', undefined, 'border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;padding:2px 6px;border-radius:6px;display:flex;align-items:center;gap:4px;white-space:nowrap;flex:none')
      const dot = document.createElement('span')
      dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:#34d399;flex:none'
      const label = document.createElement('span')
      label.textContent = tab.label
      const close = document.createElement('span')
      close.textContent = '×'
      close.style.cssText = 'cursor:pointer;opacity:0.6;padding:0 2px;border-radius:3px'
      close.title = '关闭 / Close'
      b.append(dot, label, close)
      b.addEventListener('click', (e) => {
        if (e.target === close) return
        activateTab(tab.id)
        // xterm grabs focus when its host becomes visible; put it back on
        // the label so Tab-on-label keeps working. Deferred so it wins over
        // any render-time refocus.
        setTimeout(() => { b.focus() }, 0)
      })
      // Tab on a focused tab label cycles to the next terminal.
      b.addEventListener('keydown', (e) => { tabKeyNav(e, tab) })
      // Double-click the label to rename the tab (name + working directory).
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        startRename(tab)
      })
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        closeTab(tab)
      })
      tab.btn = b
      tab.dot = dot
      tab.labelEl = label
      return b
    }

    const updateTabUi = (tab) => {
      tab.labelEl.textContent = tab.label + (tab.status === 'exited' ? ' · exited' : tab.status === 'error' ? ' · error' : '')
      tab.dot.style.background = tab.status === 'running' ? '#34d399' : tab.status === 'exited' ? '#6b7280' : '#f87171'
      tab.btn.style.background = tab.id === activeTabId ? 'rgba(65,118,230,0.25)' : 'transparent'
    }

    const activateTab = (id) => {
      activeTabId = id
      for (const tab of tabs) {
        const isActive = tab.id === id
        tab.host.style.display = isActive ? 'flex' : 'none'
        updateTabUi(tab)
        if (isActive) fitTab(tab)
        // NOTE: no term.focus() here — focusing the xterm would steal focus
        // from a just-clicked tab label, breaking "Tab on the label cycles".
        // Terminal input focuses the xterm itself when the user clicks it.
      }
      saveTermState()
    }

    const fitTab = (tab) => {
      if (!tab.term || tab.host.clientWidth === 0) return
      // Measure with font-family + font-size SEPARATELY: the font shorthand
      // without a size is invalid, silently falls back to the page font and
      // mismeasures the cell width, leaving the terminal narrower than the
      // dock (scrollbar off the right edge).
      const probe = document.createElement('div')
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:' + fonts.family + ';font-size:' + fonts.size + 'px'
      probe.textContent = 'M'
      tab.host.appendChild(probe)
      const cw = probe.getBoundingClientRect().width || 8
      probe.remove()
      const cols = Math.max(2, Math.floor(tab.host.clientWidth / cw))
      const rows = Math.max(2, Math.floor(tab.host.clientHeight / (fonts.size * 1.2)))
      tab.term.resize(cols, rows)
      window.dshDesktop.terminal.resize(tab.id, cols, rows)
    }

    const addTab = (label, cwd, id) => {
      // Restoring a saved tab reuses its PERSISTED id: the main-process
      // registry keys ptys by tab id, so the same id re-attaches to the
      // project's still-alive shell (transcript replayed) instead of
      // spawning an empty one. New tabs get a fresh sequential id.
      if (typeof id === 'string' && /^dsh-term-\d+$/.test(id)) {
        counter = Math.max(counter, Number(id.slice('dsh-term-'.length)) + 1)
      } else {
        id = 'dsh-term-' + counter
        counter += 1
      }
      // New tabs default to A-Tab / B-Tab / C-Tab … (restored tabs keep their saved name).
      // The letter is the NEXT one after this project's existing letter tabs, so a
      // fresh project starts at A-Tab and the sequence never repeats within a project.
      // ponytail: 26 letters then runs out — irrelevant in practice.
      const nextLetter = (() => {
        let max = 64 // 'A' = 65
        for (const t of tabs) {
          const m = /^([A-Z])-Tab$/.exec(t.label || '')
          if (m !== null) max = Math.max(max, m[1].charCodeAt(0))
        }
        return String.fromCharCode(max + 1)
      })()
      const tab = { id, label: (typeof label === 'string' && label !== '') ? label : (nextLetter + '-Tab'), cwd: typeof cwd === 'string' && cwd !== '' ? cwd : null, status: 'running', term: null, host: null, btn: null, dot: null, labelEl: null, resizeObs: null }
      const host = document.createElement('div')
      host.style.cssText = 'flex:1;min-height:0;position:relative;display:none'
      // Ctrl + wheel over the terminal adjusts the font size. (Tab is NOT
      // intercepted here — inside the terminal it stays the shell's key.)
      host.addEventListener('wheel', wheelFontHandler, { passive: false })
      dockBody.appendChild(host)
      tab.host = host
      tabStrip.insertBefore(mkTabBtn(tab), btnAdd)
      tabs.push(tab)
      activateTab(id)
      if (typeof window.Terminal === 'function') {
        const term = new window.Terminal({
          cursorBlink: true,
          fontSize: fonts.size,
          fontFamily: fonts.family,
          scrollback: 4000,
          allowTransparency: true,
          theme: xtermTheme(),
        })
        term.open(host)
        // Copy/paste: Ctrl+Shift+C and Ctrl+V (or Cmd on macOS) copy/paste via
        // the main-process clipboard; Ctrl+C WITH a selection copies too,
        // while a plain Ctrl+C (no selection) keeps interrupting the shell.
        term.attachCustomKeyEventHandler((e) => {
          const mod = e.ctrlKey || e.metaKey
          if (!mod) return true
          const key = e.key.toLowerCase()
          if (key === 'c') {
            if (e.shiftKey || term.hasSelection()) {
              e.preventDefault()
              const sel = term.getSelection()
              if (sel !== '') window.dshDesktop.clipboard.writeText(sel)
              return false
            }
            return true // plain Ctrl+C: let xterm send ^C to the shell
          }
          if (key === 'v') {
            e.preventDefault()
            window.dshDesktop.clipboard.readText().then((t) => {
              if (typeof t === 'string' && t !== '') term.paste(t)
            }).catch(() => {})
            return false
          }
          return true
        })
        term.onData((data) => { window.dshDesktop.terminal.input(id, data) })
        tab.term = term
        // Fit synchronously right after open: xterm starts at its default
        // 80 columns, and relying on the ResizeObserver alone can leave the
        // terminal narrower than the dock (the vertical scrollbar then sits
        // off the right edge). An immediate fit sizes it to the host now.
        fitTab(tab)
        const schedule = () => { requestAnimationFrame(() => fitTab(tab)) }
        tab.resizeObs = new ResizeObserver(schedule)
        tab.resizeObs.observe(host)
        // A restored tab carries its recorded working directory; new tabs
        // pass null and the main process uses the launch directory.
        window.dshDesktop.terminal.open(id, tab.cwd).then((res) => {
          if (res && res.error) {
            tab.status = 'error'
            term.write('\\r\\n[terminal unavailable] ' + res.error + '\\r\\n')
            updateTabUi(tab)
            return
          }
          // The main process registers the push listener before the invoke
          // resolves, so this replay always lands before the first live chunk.
          if (res && res.transcript) term.write(res.transcript)
          if (res && res.exited) {
            tab.status = 'exited'
            term.write('\\r\\n[process exited with code ' + String(res.exitCode) + ']\\r\\n')
            updateTabUi(tab)
          }
        })
      } else {
        tab.status = 'error'
        updateTabUi(tab)
        const msg = document.createElement('div')
        msg.style.cssText = 'color:var(--dsw-alias-state-error-primary);font-size:12px;padding:8px'
        msg.textContent = 'Terminal engine unavailable'
        host.appendChild(msg)
      }
      saveTermState()
    }

    // Inline rename: name + working directory (both persisted per project).
    const startRename = (tab) => {
      if (tab.renaming) return
      tab.renaming = true
      const oldLabel = tab.label
      const labelEl = tab.labelEl
      labelEl.textContent = ''
      const input = document.createElement('input')
      input.type = 'text'
      input.value = oldLabel
      input.style.cssText = 'width:90px;font-size:12px;background:rgba(255,255,255,0.08);border:1px solid rgba(65,118,230,0.4);color:var(--dsw-alias-label-primary);border-radius:4px;padding:1px 4px'
      const dirInput = document.createElement('input')
      dirInput.type = 'text'
      dirInput.value = tab.cwd !== null ? tab.cwd : ''
      dirInput.placeholder = '目录 (留空=项目根)'
      dirInput.title = '工作目录 / Working directory'
      dirInput.style.cssText = 'width:150px;font-size:11px;background:rgba(255,255,255,0.08);border:1px solid rgba(65,118,230,0.3);color:var(--dsw-alias-label-secondary);border-radius:4px;padding:1px 4px;margin-left:6px'
      labelEl.append(input, dirInput)
      const finish = (save) => {
        if (!tab.renaming) return
        tab.renaming = false
        if (save) {
          const name = input.value.trim()
          if (name !== '') tab.label = name
          const dir = dirInput.value.trim()
          if (dir !== '') tab.cwd = dir
        }
        updateTabUi(tab)
        saveTermState()
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { finish(true); return }
        if (e.key === 'Escape') { finish(false); return }
        e.stopPropagation()
      })
      dirInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { finish(true); return }
        if (e.key === 'Escape') { finish(false); return }
        e.stopPropagation()
      })
      input.addEventListener('blur', () => { finish(true) })
      dirInput.addEventListener('blur', () => { finish(true) })
      input.focus()
      input.select()
    }

    const closeTab = (tab) => {
      window.dshDesktop.terminal.close(tab.id)
      if (tab.resizeObs !== null) tab.resizeObs.disconnect()
      if (tab.term !== null) { try { tab.term.dispose() } catch {} }
      tab.btn.remove()
      tab.host.remove()
      const i = tabs.indexOf(tab)
      if (i >= 0) tabs.splice(i, 1)
      if (activeTabId === tab.id) {
        activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null
        if (activeTabId !== null) activateTab(activeTabId)
      }
      saveTermState()
    }

    // ── File panel (right side, squeezes the app, drag-resizable) ──
    // The panel floats FILES_RIGHT from the viewport edge. While it is open
    // the center column keeps the same gap from the panel as the sidebar
    // keeps from the center column: the sidebar's CSS margin-right is 4px, so
    // we set the center column's margin-right to the same 4px (FILES_GAP) and
    // push the app body right up to the panel's left edge. The two panes then
    // read as one symmetric three-column layout with equal 4px gutters.
    const FILES_RIGHT = 8 // matches the right: offset in the cssText below
    const FILES_GAP = 4 // px gutter between center column and panel (== sidebar margin-right)
    // Underlay: a frame-colored layer (--dsw-alias-bg-layer-1 = per-layer
    // alpha a) covering the panel's footprint plus its surroundings. It makes
    // the panel composite to the SAME depth as the center column: inside =
    // body + underlay + panel (three a-layers ≈ 0.533) and around = body +
    // underlay (two a-layers ≈ 0.398), matching the sidebar/center gutters.
    // Without it the panel floats on bare body (one layer) and its rounded
    // corners look more transparent than the neighboring panels.
    const filesUnderlay = document.createElement('div')
    filesUnderlay.id = 'dsh-files-underlay'
    filesUnderlay.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'bottom:0', 'z-index:9996',
      'display:none', 'background:var(--dsw-alias-bg-layer-1, rgba(15,17,23,0.224))',
    ].join(';')
    document.body.appendChild(filesUnderlay)
    const filesPanel = document.createElement('div')
    filesPanel.id = 'dsh-files-panel'
    filesPanel.style.cssText = [
      'position:fixed', 'top:8px', 'right:' + FILES_RIGHT + 'px', 'bottom:8px', 'width:340px', 'z-index:9997',
      'display:none', 'background:var(--dsh-glass-main-bg, rgba(15,17,23,0.35))', 'box-sizing:border-box',
      // Frosted like the rest of the main surface (主界面毛玻璃 slider): the
      // underlay below still supplies the second glass layer so the panel's
      // surroundings keep the two-layer depth, and the blur now matches the
      // center column/input card family instead of seaming against it.
      'backdrop-filter:blur(var(--dsh-glass-main-blur, 24px)) saturate(140%)',
      '-webkit-backdrop-filter:blur(var(--dsh-glass-main-blur, 24px)) saturate(140%)',
      'border-radius:16px',
      // NO box-shadow: the panel floats a few px right of the center column
      // (FILES_GAP), and a shadow spreading leftward toward that gutter would
      // render as a dark vertical band on the main pane (verified on screen).
      'flex-direction:column', 'font-size:13px', 'padding:6px 8px', 'gap:6px',
    ].join(';')
    document.body.appendChild(filesPanel)
    // Keep the underlay's left edge flush with the PANEL's left edge (not the
    // gutter): the frame layer already covers the gutter (body + frame = two
    // a-layers ≈ 0.398, the same as the sidebar/center surroundings), so the
    // 4px gap stays visible as a lighter seam. Extending the underlay into the
    // gutter would stack a third layer there and visually fill the gap.
    const syncFilesUnderlay = () => {
      const r = filesPanel.getBoundingClientRect()
      filesUnderlay.style.left = r.left + 'px'
    }
    // Window resize (e.g. Win+F fullscreen) changes the panel's left edge
    // (it is anchored to the right viewport edge), so the underlay must
    // follow. Without this the underlay stays at the pre-resize left and
    // leaves a wide two-layer band between it and the panel — visibly lighter
    // than the center column's three layers.
    const onFilesResize = () => {
      if (filesPanel.style.display === 'flex') syncFilesUnderlay()
    }
    window.addEventListener('resize', onFilesResize)

    // The DSH sidebar groups sessions under workspace headers; the header
    // (first child) of the group containing the currently selected session
    // row is the workspace title, e.g. "projects" or "Code".
    const getWorkspaceName = () => {
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
    const filesOpen = () => {
      filesPanel.style.display = 'flex'
      filesUnderlay.style.display = 'block'
      syncFilesUnderlay()
      btnFiles.style.display = 'none' // the open panel occupies that corner
      // Squeeze the app up to the panel's left edge (right offset + width),
      // then give the center column the same 4px right margin the sidebar
      // carries (FILES_GAP), so the two gutters match. The center column keeps
      // its own rounded corners; the panel is rounded on all four too.
      document.body.style.paddingRight = (FILES_RIGHT + filesPanel.getBoundingClientRect().width) + 'px'
      const col = document.querySelector('[class*="_centerCol"]')
      // The ambient glass CSS pins the center column's margin with !important
      // (margin: 8px 8px 8px 0), so a plain assignment cannot override it.
      if (col !== null) col.style.setProperty('margin-right', FILES_GAP + 'px', 'important')
      // The center column's scrollbar sits right at its own right edge; hide
      // it while the panel is open so it does not read as a divider next to
      // the floating panel (wheel scrolling still works). Restored on close.
      if (document.getElementById('dsh-files-scroll-hide') === null) {
        const s = document.createElement('style')
        s.id = 'dsh-files-scroll-hide'
        s.textContent = '[class*="_centerCol"] *::-webkit-scrollbar { display: none !important; } [class*="_centerCol"] * { scrollbar-width: none !important; }'
        document.head.appendChild(s)
      }
      // Open at the CURRENT session's workspace directory (the DSH sidebar
      // groups sessions by workspace: the selected row's groupSection header
      // is the workspace title, resolved to a real path in the main process).
      openAtWorkspace()
    }
    const openAtWorkspace = () => {
      const wsName = getWorkspaceName()
      forwardStack = []
      if (wsName === null) { renderList(null, false); return }
      window.dshDesktop.fs.workspace(wsName).then((r) => {
        if (r && typeof r.path === 'string' && r.path !== '') renderList(r.path, false)
        else renderList(null, false)
      }).catch(() => { renderList(null, false) })
    }
    const filesClose = () => {
      filesPanel.style.display = 'none'
      filesUnderlay.style.display = 'none'
      btnFiles.style.display = 'flex' // restore the toggle once closed
      document.body.style.paddingRight = ''
      const col = document.querySelector('[class*="_centerCol"]')
      if (col !== null) {
        col.style.removeProperty('border-radius')
        col.style.removeProperty('margin-right')
      }
      const s = document.getElementById('dsh-files-scroll-hide')
      if (s !== null) s.remove()
    }
    const syncFilesBottom = () => {
      filesPanel.style.bottom = termDock.style.display === 'flex' ? (DOCK_H + 8) + 'px' : '8px'
    }

    // ── Feature visibility (主题设置 → 桌面功能 toggles) ──
    // The 显示浏览文件夹 / 显示终端 switches decide whether the panels and
    // their floating toggle buttons exist at all. Persisted in localStorage;
    // live changes arrive as window events from featureControlScript.
    const featureVisible = (key) => {
      try {
        const raw = localStorage.getItem(key)
        if (raw !== null) return JSON.parse(raw) !== false
      } catch {}
      return true
    }
    const applyPanelVisibility = () => {
      const filesOn = featureVisible('dsh-desktop-files-visible')
      const termOn = featureVisible('dsh-desktop-terminal-visible')
      if (!filesOn) {
        btnFiles.style.display = 'none'
        if (filesPanel.style.display === 'flex') filesClose()
      } else {
        btnFiles.style.display = filesPanel.style.display === 'flex' ? 'none' : 'flex'
      }
      if (!termOn) {
        btnTerm.style.display = 'none'
        if (termDock.style.display === 'flex') termClose()
      } else {
        btnTerm.style.display = termDock.style.display === 'flex' ? 'none' : 'flex'
      }
    }
    const onFilesVisibleChange = (e) => {
      const on = e.detail ? e.detail.visible !== false : true
      if (on) btnFiles.style.display = filesPanel.style.display === 'flex' ? 'none' : 'flex'
      else {
        btnFiles.style.display = 'none'
        if (filesPanel.style.display === 'flex') filesClose()
      }
    }
    const onTerminalVisibleChange = (e) => {
      const on = e.detail ? e.detail.visible !== false : true
      if (on) btnTerm.style.display = termDock.style.display === 'flex' ? 'none' : 'flex'
      else {
        btnTerm.style.display = 'none'
        if (termDock.style.display === 'flex') termClose()
      }
    }
    window.addEventListener('dsh-files-visible-change', onFilesVisibleChange)
    window.addEventListener('dsh-terminal-visible-change', onTerminalVisibleChange)
    applyPanelVisibility()

    // Drag the panel's left edge to resize; the app squeeze follows.
    const resizeHandle = document.createElement('div')
    resizeHandle.style.cssText = 'position:absolute;left:-5px;top:0;bottom:0;width:10px;cursor:ew-resize;z-index:6'
    filesPanel.appendChild(resizeHandle)
    resizeHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = filesPanel.getBoundingClientRect().width
      const move = (ev) => {
        const w = Math.min(640, Math.max(240, startW + startX - ev.clientX))
        filesPanel.style.width = w + 'px'
        document.body.style.paddingRight = (FILES_RIGHT + w) + 'px'
        syncFilesUnderlay()
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })

    // Navigable browser state: current dir + back/forward history.
    let currentPath = null // null = app root (process.cwd())
    let navHistory = []
    let navIndex = -1
    let lastParent = null
    // ‹ › walk the directory tree, not browser history: Back goes to the
    // parent directory (all the way up to the filesystem root), Forward
    // re-enters the directory we just left (a simple stack of the paths ‹
    // stepped out of).
    let forwardStack = []

    const filesPathBar = document.createElement('div')
    filesPathBar.style.cssText = 'display:flex;align-items:center;gap:4px;flex:none'
    // Shared path-bar button style: bigger hit area + glyphs.
    const PB_BTN = 'border:1px solid rgba(65,118,230,0.3);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;width:30px;height:30px;cursor:pointer;font-size:16px;line-height:1;flex:none;display:flex;align-items:center;justify-content:center'
    const HOME_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5L8 2.8l5.5 4.7"/><path d="M4.2 6.8V13h7.6V6.8"/></svg>'
    // Home jumps straight to the user's home directory ("~" expands server-side).
    const btnHome = mkBtn(HOME_ICON, undefined, PB_BTN)
    const btnBack = mkBtn('‹', undefined, PB_BTN)
    const btnFwd = mkBtn('›', undefined, PB_BTN)
    // Hidden-file toggle: dotfiles are filtered out by default; the button
    // (label "·.") flips the filter and re-renders the current directory.
    let showHidden = false
    const btnHidden = mkBtn('·.', undefined, PB_BTN)
    const paintHidden = () => { btnHidden.style.background = showHidden ? 'rgba(65,118,230,0.35)' : 'transparent' }
    btnHidden.addEventListener('click', () => { showHidden = !showHidden; paintHidden(); renderList(currentPath, false) })
    const filesRootLabel = document.createElement('span')
    filesRootLabel.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:13px;font-family:Menlo,Consolas,monospace;cursor:text'
    const btnRefresh = mkBtn('↻', undefined, PB_BTN)
    // The floating files toggle hides while the panel is open, so the panel
    // itself needs an explicit close affordance in the top-right corner.
    const btnCloseFiles = mkBtn('×', undefined, PB_BTN)
    filesPathBar.append(btnHome, btnBack, btnFwd, btnHidden, filesRootLabel, btnRefresh, btnCloseFiles)
    filesPanel.appendChild(filesPathBar)

    const treeHost = document.createElement('div')
    treeHost.style.cssText = 'flex:1;min-height:0;overflow:auto;font-family:Menlo,Consolas,monospace;font-size:14px;color:var(--dsw-alias-label-primary)'
    filesPanel.appendChild(treeHost)

    const previewHost = document.createElement('div')
    previewHost.style.cssText = 'display:none;flex:none;max-height:40%;overflow:auto;border:1px solid rgba(65,118,230,0.25);border-radius:6px;background:rgba(255,255,255,0.03);padding:6px 8px;font-family:Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary)'
    filesPanel.appendChild(previewHost)

    const showPreview = (entry) => {
      previewHost.textContent = ''
      const title = document.createElement('div')
      title.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;color:var(--dsw-alias-label-tertiary);font-size:11px'
      const close = mkBtn('×', undefined, 'border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;line-height:1;margin-left:auto')
      title.append(document.createTextNode(entry.name + (entry.size !== null ? ' — ' + entry.size + ' bytes' : '')), close)
      previewHost.appendChild(title)
      const content = document.createElement('div')
      previewHost.appendChild(content)
      const bodyText = document.createElement('div')
      content.appendChild(bodyText)
      close.addEventListener('click', () => { previewHost.style.display = 'none' })
      window.dshDesktop.fs.read(entry.path).then((res) => {
        if (res && res.error) { bodyText.textContent = String(res.error) }
        else if (res && res.kind === 'binary') {
          bodyText.textContent = 'Binary file (' + res.size + ' bytes)' + (res.truncated ? ', truncated' : '')
        } else if (res && res.kind === 'text') {
          bodyText.textContent = res.content
          if (res.truncated) bodyText.textContent += '\\n… (truncated at 512 KiB)'
        } else {
          bodyText.textContent = 'Unavailable'
        }
      })
      previewHost.style.display = 'block'
    }

    // Git change-badge mapping: worktree code wins over index, '??' untracked.
    const badgeFor = (xy) => {
      if (xy === '??') return { ch: '?', label: 'untracked', color: '#9ca3af' }
      const code = xy[0] !== ' ' ? xy[0] : xy[1]
      if (code === 'M') return { ch: 'M', label: 'modified', color: '#eab308' }
      if (code === 'A') return { ch: 'A', label: 'added', color: '#22c55e' }
      if (code === 'D') return { ch: 'D', label: 'deleted', color: '#ef4444' }
      if (code === 'R' || code === 'C') return { ch: code, label: code === 'R' ? 'renamed' : 'copied', color: '#60a5fa' }
      if (code === 'U' || code === 'T') return { ch: code, label: 'conflicted', color: '#ef4444' }
      return { ch: code, label: 'changed', color: '#9ca3af' }
    }

    let gitInfo = { branch: null, byPath: new Map() }
    const loadGitInfo = () => {
      if (!window.dshDesktop.git) return Promise.resolve({ branch: null, byPath: new Map() })
      return window.dshDesktop.git.status().then((g) => {
        if (g && g.isRepo) {
          return { branch: g.branch, byPath: new Map((g.entries || []).map((e) => [e.path, e.xy])) }
        }
        return { branch: null, byPath: new Map() }
      }).catch(() => ({ branch: null, byPath: new Map() }))
    }

    const entryRow = (entry, container) => {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer'
      const glyph = document.createElement('span')
      glyph.textContent = entry.kind === 'directory' ? '▱' : '▤'
      glyph.style.cssText = 'width:14px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:14px'
      const name = document.createElement('span')
      name.textContent = entry.name
      name.style.cssText = (entry.kind === 'directory' ? 'color:#7fb3ff;' : 'color:var(--dsw-alias-label-secondary);') + 'overflow:hidden;text-overflow:ellipsis'
      row.append(glyph, name)
      row.addEventListener('click', () => {
        if (entry.kind === 'directory') navigateTo(entry.path, true)
        else showPreview(entry)
      })
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.06)' })
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent' })
      if (entry.kind !== 'directory') {
        const xy = gitInfo.byPath.get(entry.path)
        if (xy !== undefined) {
          const b = badgeFor(xy)
          const badge = document.createElement('span')
          badge.textContent = b.ch
          badge.title = b.label
          badge.style.cssText = 'margin-left:auto;flex:none;font-size:10px;font-weight:bold;color:' + b.color
          row.append(badge)
        }
      }
      return row
    }

    const navigateTo = (path, recordHistory) => {
      if (recordHistory) {
        // Seed the history with the starting directory so Back can return
        // to it (a first navigation otherwise leaves a single-entry stack).
        // The seed must also advance navIndex, or the slice below (which
        // keeps up to navIndex+1 entries) would drop it.
        if (navHistory.length === 0) {
          navHistory.push(currentPath)
          navIndex = 0
        }
        navHistory = navHistory.slice(0, navIndex + 1)
        navHistory.push(path)
        navIndex = navHistory.length - 1
      }
      currentPath = path
      renderList(path, false)
    }
    const goBack = () => {
      if (lastParent === null) return
      forwardStack.push(currentPath)
      renderList(lastParent, false)
    }
    const goForward = () => {
      const next = forwardStack.pop()
      if (next !== undefined) renderList(next, false)
    }

    // Click the path label to edit it manually: type a path and press Enter
    // to navigate, Escape or blur to cancel.
    const startPathEdit = () => {
      if (filesRootLabel.querySelector('input') !== null) return
      const current = currentPath !== null ? currentPath : ''
      filesRootLabel.textContent = ''
      const input = document.createElement('input')
      input.type = 'text'
      input.value = current
      input.style.cssText = 'flex:1;min-width:0;font-size:11px;font-family:Menlo,Consolas,monospace;background:rgba(255,255,255,0.08);border:1px solid rgba(65,118,230,0.4);color:var(--dsw-alias-label-primary);border-radius:4px;padding:1px 4px'
      filesRootLabel.appendChild(input)
      input.focus()
      input.select()
      // The click event flow (mousedown default focusing, page-level focus
      // managers) can yank focus back off the input right after this handler
      // returns, which would blur → finish(false) and cancel the edit.
      // Re-assert focus on the next tick so typing lands in the input.
      setTimeout(() => {
        if (input.parentElement === filesRootLabel) { input.focus(); input.select() }
      }, 0)
      const finish = (apply) => {
        if (input.parentElement !== filesRootLabel) return
        input.remove()
        if (apply) {
          const p = input.value.trim()
          // Navigating to the path we already show is a no-op: just restore.
          if (p !== '' && p !== current) navigateTo(p, true)
          else filesRootLabel.textContent = current
        } else {
          filesRootLabel.textContent = current
        }
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { finish(true); return }
        if (e.key === 'Escape') { finish(false); return }
        e.stopPropagation()
      })
      // blur COMMITS (browser address-bar style): the page's focus manager
      // can yank focus off the input right as the user hits Enter, which
      // would otherwise cancel the edit through the old finish(false) path.
      input.addEventListener('blur', () => { finish(true) })
    }
    // Trigger on mousedown (not click) with preventDefault: the browser's
    // default mousedown focus lands on the label/body and the page's focus
    // manager then yanks focus off the input a few ticks later, blurring →
    // finish(false) → cancelling the edit. preventDefault keeps that default
    // focus from happening, so input.focus() in startPathEdit wins.
    filesRootLabel.addEventListener('mousedown', (e) => {
      e.preventDefault()
      startPathEdit()
    })

    // List renders are async; rapid back/forward clicks can interleave their
    // fs.list responses and end up showing a stale directory. A monotonic
    // token drops every stale response so only the newest navigation lands.
    let listSeq = 0
    const renderList = (path, pushHistory) => {
      if (pushHistory) {
        navHistory = navHistory.slice(0, navIndex + 1)
        navHistory.push(path)
        navIndex = navHistory.length - 1
      }
      const seq = ++listSeq
      currentPath = path
      console.log('[path-edit] renderList', path, seq)
      treeHost.textContent = ''
      const root = document.createElement('div')
      root.style.cssText = 'padding:2px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:2px'
      root.textContent = '…'
      treeHost.appendChild(root)
      btnBack.disabled = true // refined below once fs.list resolves
      btnFwd.disabled = forwardStack.length === 0
      Promise.all([window.dshDesktop.fs.list(path), loadGitInfo()]).then(([res, info]) => {
        if (seq !== listSeq) return
        if (res && res.error) {
          root.textContent = String(res.error)
          return
        }
        gitInfo = info
        lastParent = res.parent !== null ? res.parent : null
        btnBack.disabled = lastParent === null
        btnFwd.disabled = forwardStack.length === 0
        filesRootLabel.textContent = res.path
        treeHost.textContent = ''
        const visible = (res.entries || []).filter((e) => showHidden || !String(e.name || '').startsWith('.'))
        for (const entry of visible) treeHost.appendChild(entryRow(entry, treeHost))
        if (visible.length === 0) {
          const empty = document.createElement('div')
          empty.style.cssText = 'color:var(--dsw-alias-label-tertiary);font-size:12px;padding:4px'
          empty.textContent = 'Empty directory'
          treeHost.appendChild(empty)
        }
      })
    }

    // ── Global data routing: one subscription, tab-tagged ──
    const unsubData = window.dshDesktop.terminal.onData((tabId, data) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (tab !== undefined && tab.term !== null) tab.term.write(data)
    })
    const unsubExit = window.dshDesktop.terminal.onExit((tabId, code) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (tab === undefined) return
      tab.status = 'exited'
      if (tab.term !== null) tab.term.write('\\r\\n[process exited with code ' + String(code) + ']\\r\\n')
      updateTabUi(tab)
    })

    // ── Theme follow: re-theme every xterm when the SPA flips the flag ──
    const themeObs = new MutationObserver(() => {
      const theme = xtermTheme()
      for (const tab of tabs) {
        if (tab.term !== null) {
          tab.term.options.theme = theme
          tab.term.refresh(0, tab.term.rows - 1)
        }
      }
    })
    themeObs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })

    // ── Project switch: the selected session changes → swap terminal set ──
    // Debounced: session rows re-render frequently (time labels tick), so a
    // key change is honored only after the DOM has settled.
    let projectDebounce
    const projectObs = new MutationObserver(() => {
      clearTimeout(projectDebounce)
      projectDebounce = setTimeout(() => {
        const key = getProjectKey()
        if (key !== currentProjectKey) swapTerminals(key)
      }, 300)
    })
    // Observe document.body, not the sidebar: React rebuilds the sidebar on
    // session switches, which would silently detach an observer on it.
    projectObs.observe(document.body, { attributes: true, attributeFilter: ['aria-selected', 'class'], childList: true, subtree: true })

    // ── Wire up: two independent toggles ──
    btnAdd.addEventListener('click', addTab)
    btnCollapse.addEventListener('click', termClose)
    btnRefresh.addEventListener('click', () => { renderList(currentPath, false) })
    btnCloseFiles.addEventListener('click', filesClose)
    btnHome.addEventListener('click', () => { navigateTo('~', true) })
    btnBack.addEventListener('click', goBack)
    btnFwd.addEventListener('click', goForward)
    btnTerm.addEventListener('click', termOpen)
    btnFiles.addEventListener('click', () => {
      const show = filesPanel.style.display !== 'flex'
      if (show) filesOpen()
      else filesClose()
    })

    window.__dshTerminal = {
      dispose: () => {
        unsubData()
        unsubExit()
        themeObs.disconnect()
        sessObs.disconnect()
        if (sessResizeObs !== null) sessResizeObs.disconnect()
        projectObs.disconnect()
        sidebarObs.disconnect()
        if (sidebarResizeObs !== null) sidebarResizeObs.disconnect()
        sidebarRebuildObs.disconnect()
        document.getElementById('dsh-topbar-style')?.remove()
        document.getElementById('dsh-sesslog-style')?.remove()
        document.body.style.paddingRight = ''
        const center = document.querySelector('[class*="_centerCol"]')
        if (center !== null) {
          center.style.height = ''
          center.style.removeProperty('margin-right')
        }
        for (const tab of [...tabs]) {
          window.dshDesktop.terminal.close(tab.id)
          if (tab.resizeObs !== null) tab.resizeObs.disconnect()
          if (tab.term !== null) { try { tab.term.dispose() } catch {} }
        }
        btnTerm.remove()
        btnFiles.remove()
        window.removeEventListener('dsh-files-visible-change', onFilesVisibleChange)
        window.removeEventListener('dsh-terminal-visible-change', onTerminalVisibleChange)
        termUnderlay.remove()
        termDock.remove()
        window.removeEventListener('resize', onFilesResize)
        filesUnderlay.remove()
        filesPanel.remove()
      },
    }
  })()`
}

/**
 * The wallpaper layer injected into the hosted page: a fixed, full-viewport
 * div at the bottom of the stacking order (z-index -1) that sits between the
 * page background and the SPA's translucent glass canvas layers. The picked
 * image is blurred slightly and darkened so chat text stays readable, and
 * scaled past the viewport edge so the blur never shows a white rim.
 *
 * The URL is fetched asynchronously through the preload bridge and parked on
 * a window global (`__dshWallpaperUrl`) so repeated injections and the
 * self-healing observer never re-fetch it; a MutationObserver re-appends the
 * layer if the SPA re-renders it away, mirroring the glass guard's pattern.
 */
export function wallpaperLayerScript(): string {
  return `(() => {
    if (window.__dshWallpaperObserver) {
      window.__dshWallpaperObserver.disconnect()
      window.__dshWallpaperObserver = undefined
    }
    const ensure = () => {
      let el = document.getElementById('dsh-dt-wallpaper')
      if (el === null) {
        el = document.createElement('div')
        el.id = 'dsh-dt-wallpaper'
        el.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;' +
          'background-size:cover;background-position:center;background-repeat:no-repeat;' +
          'filter:blur(8px) brightness(0.72);transform:scale(1.06)'
        document.body.prepend(el)
      }
      const url = window.__dshWallpaperUrl
      el.style.backgroundImage = url ? 'url("' + url + '")' : 'none'
    }
    ensure()
    const obs = new MutationObserver(ensure)
    window.__dshWallpaperObserver = obs
    obs.observe(document.body, { childList: true, subtree: true })
    window.dshDesktop.wallpaper.get().then((res) => {
      const r = res
      window.__dshWallpaperUrl = (r !== null && typeof r === 'object' && typeof r.url === 'string') ? r.url : null
      ensure()
    }).catch(() => {})
  })()`
}

/**
 * Injected UI for the background wallpaper in the hosted settings page,
 * mounted below the background-opacity control (通用设置 → 外观). Same mount
 * strategy as the alpha slider: watch the DOM, mount on the Appearance row,
 * keep an existing control in place (locale switches only re-sync the title).
 * The "choose" button opens the system file dialog in the main process via
 * the preload bridge; "remove" clears the wallpaper.
 */
export function wallpaperControlScript(): string {
  return `(() => {
    if (window.__dshWallpaperControlObserver) {
      window.__dshWallpaperControlObserver.disconnect()
      window.__dshWallpaperControlObserver = undefined
    }
    const MOUNTED = '[data-dsh-wallpaper]'
    const mount = () => {
      if (window.dshDesktop === undefined) return
      // The wallpaper control lives in the injected Theme Settings panel
      // (主题设置), mounted by themeSettingsScript.
      const panel = document.querySelector('[data-dsh-theme-panel]')
      if (panel === null) return
      const zh = window.__dshThemeLocale !== 'en'
      const title = zh ? '背景壁纸' : 'Wallpaper'
      const existing = document.querySelector(MOUNTED)
      if (existing !== null) {
        const titleEl = existing.firstElementChild
        if (titleEl !== null && titleEl.textContent !== title) titleEl.textContent = title
        return
      }
        const folderLabel = zh ? '选择文件夹…' : 'Choose folder…'
        const pickLabel = zh ? '选择壁纸…' : 'Choose wallpaper…'
        const clearLabel = zh ? '移除' : 'Remove'
        const hintLabel = zh ? '双击缩略图切换壁纸' : 'Double-click a thumbnail to apply'
        const control = document.createElement('div')
        control.dataset.dshWallpaper = 'true'
        control.style.cssText = 'flex-direction:column;gap:10px;padding:16px 0;display:flex'
        control.innerHTML =
          '<div style="color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px"></div>' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
            '<button data-dsh-wallpaper-folder style="background:#4176e6;color:#fff;border:none;border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer">' + folderLabel + '</button>' +
            '<button data-dsh-wallpaper-pick style="background:transparent;color:var(--dsw-alias-label-primary);border:1px solid rgba(65,118,230,0.4);border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer">' + pickLabel + '</button>' +
            '<button data-dsh-wallpaper-clear style="background:transparent;color:var(--dsw-alias-label-primary);border:1px solid rgba(128,132,142,0.4);border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer">' + clearLabel + '</button>' +
            '<span data-dsh-wallpaper-name style="flex:1;min-width:120px;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right"></span>' +
          '</div>' +
          '<div data-dsh-wallpaper-hint style="color:var(--dsw-alias-label-tertiary);font-size:11px;display:none">' + hintLabel + '</div>' +
          '<div data-dsh-wallpaper-grid style="display:none;grid-template-columns:repeat(3,1fr);gap:6px;overflow-y:auto;padding-right:2px"></div>' +
          '<style>' +
            '[data-dsh-wallpaper-grid] .dsh-wp-cell { position:relative; aspect-ratio:16/10; border-radius:8px; overflow:hidden; cursor:pointer; background:rgba(128,132,142,0.15); flex:none; }' +
            '[data-dsh-wallpaper-grid] .dsh-wp-cell img { width:100%; height:100%; object-fit:cover; display:block; }' +
            '[data-dsh-wallpaper-grid] .dsh-wp-cell .dsh-wp-badge { position:absolute; top:4px; right:4px; width:14px; height:14px; border-radius:50%; background:rgba(15,17,23,0.7); border:2px solid #4176e6; display:none; }' +
            '[data-dsh-wallpaper-grid] .dsh-wp-cell.dsh-wp-active { outline:2px solid #4176e6; outline-offset:-2px; }' +
            '[data-dsh-wallpaper-grid] .dsh-wp-cell.dsh-wp-active .dsh-wp-badge { display:block; }' +
            '[data-dsh-wallpaper-grid] .dsh-wp-cell:hover { outline:1px solid rgba(255,255,255,0.35); outline-offset:-1px; }' +
          '</style>'
        const titleEl = control.firstElementChild
        if (titleEl !== null) titleEl.textContent = title
        const folderBtn = control.querySelector('[data-dsh-wallpaper-folder]')
        const pickBtn = control.querySelector('[data-dsh-wallpaper-pick]')
        const clearBtn = control.querySelector('[data-dsh-wallpaper-clear]')
        const nameEl = control.querySelector('[data-dsh-wallpaper-name]')
        const grid = control.querySelector('[data-dsh-wallpaper-grid]')
        const hint = control.querySelector('[data-dsh-wallpaper-hint]')
        if (folderBtn === null || pickBtn === null || clearBtn === null || nameEl === null || grid === null || hint === null) return
        const apply = (url, file, srcPath) => {
          window.__dshWallpaperUrl = url
          nameEl.textContent = file === null ? '' : file
          const layer = document.getElementById('dsh-dt-wallpaper')
          if (layer !== null) layer.style.backgroundImage = url ? 'url("' + url + '")' : 'none'
          if (typeof srcPath === 'string' && srcPath !== '') {
            try { localStorage.setItem('dsh-desktop-wallpaper-src', srcPath) } catch {}
            grid.querySelectorAll('.dsh-wp-cell').forEach((cell) => {
              cell.classList.toggle('dsh-wp-active', cell.dataset.path === srcPath)
            })
          }
        }
        // ── Thumbnail grid: 3 columns, 2 visible rows, vertical scroll ──
        // Cells load their thumbnails lazily (IntersectionObserver) so a
        // large folder does not decode every image up front. Requests are
        // also SERIALIZED (one in flight): each decode is a synchronous
        // nativeImage pass on the main process, so concurrent requests
        // freeze the window (measured 756ms IPC stall while the grid loaded);
        // a queue keeps the main process responsive and thumbnails fill in
        // gradually.
        const thumbQueue = []
        let thumbBusy = false
        const pumpThumbs = () => {
          if (thumbBusy || thumbQueue.length === 0) return
          const cell = thumbQueue.shift()
          thumbBusy = true
          window.dshDesktop.wallpaper.thumb(cell.dataset.path).then((res) => {
            if (cell.isConnected && res !== null && typeof res === 'object' && typeof res.url === 'string') {
              const img = cell.querySelector('img')
              if (img !== null) img.src = res.url
            }
            thumbBusy = false
            pumpThumbs()
          }).catch(() => { thumbBusy = false; pumpThumbs() })
        }
        const loadThumb = (cell) => {
          if (cell.dataset.loaded === '1') return
          cell.dataset.loaded = '1'
          thumbQueue.push(cell)
          pumpThumbs()
        }
        let thumbObs = null
        const computeGridH = () => {
          // 2 rows of 16:10 cells + one 6px gap.
          const cellW = (grid.clientWidth - 12) / 3
          grid.style.maxHeight = Math.round(cellW * 0.625 * 2 + 6) + 'px'
        }
        const renderGrid = (entries) => {
          grid.textContent = ''
          if (!Array.isArray(entries) || entries.length === 0) {
            grid.style.display = 'none'
            hint.style.display = 'none'
            return
          }
          grid.style.display = 'grid'
          hint.style.display = ''
          const curSrc = (() => { try { return localStorage.getItem('dsh-desktop-wallpaper-src') } catch { return null } })()
          for (const e of entries) {
            const cell = document.createElement('div')
            cell.className = 'dsh-wp-cell'
            cell.dataset.path = e.path
            cell.innerHTML = '<img alt="">' + '<span class="dsh-wp-badge"></span>'
            if (curSrc === e.path) cell.classList.add('dsh-wp-active')
            cell.addEventListener('dblclick', () => {
              window.dshDesktop.wallpaper.apply(e.path).then((res) => {
                if (res === null || typeof res !== 'object') return
                if (typeof res.error === 'string') { alert(res.error); return }
                if (typeof res.url === 'string') {
                  apply(res.url, typeof res.file === 'string' ? res.file : null, e.path)
                }
              }).catch(() => {})
            })
            grid.appendChild(cell)
            if (thumbObs !== null) thumbObs.observe(cell)
          }
          computeGridH()
        }
        thumbObs = new IntersectionObserver((entries) => {
          for (const en of entries) {
            if (en.isIntersecting) {
              loadThumb(en.target)
              thumbObs.unobserve(en.target)
            }
          }
        }, { root: grid, rootMargin: '120px' })
        const onWinResize = () => { if (grid.isConnected && grid.style.display !== 'none') computeGridH() }
        // The control is recreated on every panel open and has no dispose
        // hook, so keep at most ONE resize listener via a window registry.
        const prevResize = window.__dshWpResizeHandlers || []
        prevResize.forEach((h) => window.removeEventListener('resize', h))
        window.__dshWpResizeHandlers = [onWinResize]
        window.addEventListener('resize', onWinResize)
        folderBtn.addEventListener('click', () => {
          window.dshDesktop.wallpaper.folderPick().then((res) => {
            if (res === null || typeof res !== 'object') return
            if (res.canceled) return
            if (typeof res.error === 'string') { alert(res.error); return }
            if (typeof res.path === 'string' && res.path !== '') {
              try { localStorage.setItem('dsh-desktop-wallpaper-folder', res.path) } catch {}
            }
            nameEl.textContent = typeof res.path === 'string' ? res.path : ''
            renderGrid(res.entries)
          }).catch(() => {})
        })
        pickBtn.addEventListener('click', () => {
          window.dshDesktop.wallpaper.pick().then((res) => {
            if (res === null || typeof res !== 'object') return
            if (res.canceled) return
            if (typeof res.error === 'string') { alert(res.error); return }
            if (typeof res.url === 'string') {
              apply(res.url, typeof res.file === 'string' ? res.file : null, typeof res.srcPath === 'string' ? res.srcPath : null)
            }
          }).catch(() => {})
        })
        clearBtn.addEventListener('click', () => {
          window.dshDesktop.wallpaper.clear().then((res) => {
            if (res !== null && typeof res === 'object' && res.ok) apply(null, null, null)
          }).catch(() => {})
        })
        window.dshDesktop.wallpaper.get().then((res) => {
          if (res !== null && typeof res === 'object') {
            const url = typeof res.url === 'string' ? res.url : null
            apply(url, typeof res.file === 'string' ? res.file : null, null)
          }
        }).catch(() => {})
        // Restore the last browsed folder's grid without reopening the
        // dialog. Delayed ~350ms so the panel switch animation settles before
        // the grid starts decoding thumbnails (the decode queue otherwise
        // competes with the transition and reads as a hitch).
        const lastFolder = (() => { try { return localStorage.getItem('dsh-desktop-wallpaper-folder') } catch { return null } })()
        if (lastFolder !== null && lastFolder !== '') {
          setTimeout(() => {
            window.dshDesktop.fs.list(lastFolder).then((res) => {
              if (res === null || typeof res !== 'object' || res.error || !Array.isArray(res.entries)) return
              const imgs = res.entries.filter((e) => e && typeof e.name === 'string' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(e.name)).map((e) => ({ name: e.name, path: e.path }))
              nameEl.textContent = typeof res.path === 'string' ? res.path : ''
              renderGrid(imgs)
            }).catch(() => {})
          }, 350)
        }
      // Mount inside the Theme Settings panel's dedicated wallpaper slot (the
      // first block in the panel, above the brand color-switch interval).
      const holder = panel.querySelector('[data-dsh-theme-wallpaper-slot]') || panel
      holder.appendChild(control)
    }
    mount()
    const obs = new MutationObserver(mount)
    window.__dshWallpaperControlObserver = obs
    // childList: row (re)mounts; characterData: locale switches swap text in
    // place, which must re-sync the mounted control's title.
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
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
        files: zh ? '显示浏览文件夹' : 'Show file browser',
        term: zh ? '显示终端' : 'Show terminal',
        cycle: zh ? '标题颜色切换时间' : 'Brand color interval',
        unit: zh ? '秒' : 's',
      }
      // ── Cycle interval control (own block, ABOVE the opacity slider) ──
      let cycleControl = document.querySelector('[data-dsh-cycle-control]')
      if (cycleControl === null) {
        const holder = panel.querySelector('[data-dsh-theme-cycle-slot]') || panel
        cycleControl = document.createElement('div')
        cycleControl.dataset.dshCycleControl = 'true'
        cycleControl.style.cssText = 'display:flex;align-items:center;gap:10px;padding:16px 0'
        cycleControl.innerHTML =
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px;flex:1" data-dsh-label-cycle></span>' +
          '<input type="number" min="1" max="600" step="1" data-dsh-cycle-input style="width:64px;background:rgb(39,46,62);color:var(--dsw-alias-label-primary);border:none;border-radius:10px;padding:6px 8px;font-size:13px;text-align:center;outline:none">' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:12px;min-width:24px" data-dsh-cycle-unit></span>'
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
        '<label style="display:flex;align-items:center;gap:10px;cursor:pointer">' +
          '<span class="dsh-switch">' +
            '<input type="checkbox" data-dsh-toggle-files>' +
            '<span class="track"></span><span class="thumb"></span>' +
          '</span>' +
          '<span style="color:var(--dsw-alias-label-secondary);font-size:13px" data-dsh-label-files></span>' +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:10px;cursor:pointer">' +
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
    const obs = new MutationObserver(mount)
    window.__dshFeatureControlObserver = obs
    // childList: row (re)mounts; characterData: locale switches swap text in
    // place, which must re-sync the mounted controls' labels.
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
  })()`
}

/**
 * Injected UI for the unified frosted-glass controls in the Theme Settings
 * panel (主题设置 → 界面毛玻璃): two independent sliders — one for the MAIN
 * surface (composer card, task strip, user bubbles, popup menus) and one for
 * the SETTINGS surface (the hosted settings panel itself). Each writes a
 * single pair of CSS variables consumed by the ambientStyleScript rules, so
 * one slider re-themes every surface of that family at once instead of
 * configuring them one by one. Values persist to localStorage (percent,
 * default 35) and apply immediately via the `#dsh-glass-custom` style node.
 */
export function glassControlsScript(): string {
  return `(() => {
    if (window.__dshGlassControlObserver) {
      window.__dshGlassControlObserver.disconnect()
      window.__dshGlassControlObserver = undefined
    }
    const KEYS = { main: 'dsh-desktop-glass-main', settings: 'dsh-desktop-glass-settings' }
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
    let mainVal = Math.max(20, Math.min(60, read(KEYS.main, 35)))
    let settingsVal = Math.max(20, Math.min(60, read(KEYS.settings, 35)))
    // One style node carries the four glass variables; ambientStyleScript's
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
      s.textContent = 'body { ' +
        '--dsh-glass-main-bg: ' + a(mainVal) + '; ' +
        '--dsh-glass-main-blur: 24px; ' +
        '--dsh-glass-settings-bg: ' + a(settingsVal) + '; ' +
        '--dsh-glass-settings-blur: 24px; ' +
      '}'
    }
    const mount = () => {
      if (window.dshDesktop === undefined) return
      const panel = document.querySelector('[data-dsh-theme-panel]')
      if (panel === null) return
      const zh = window.__dshThemeLocale !== 'en'
      const labels = {
        title: zh ? '界面毛玻璃' : 'Interface glass',
        main: zh ? '主界面毛玻璃' : 'Main surface',
        settings: zh ? '设置界面毛玻璃' : 'Settings surface',
      }
      const existing = document.querySelector('[data-dsh-glass-controls]')
      if (existing !== null) {
        const sync = (sel, text) => {
          const el = existing.querySelector(sel)
          if (el !== null && el.textContent !== text) el.textContent = text
        }
        sync('[data-dsh-glass-title]', labels.title)
        sync('[data-dsh-glass-main-label]', labels.main)
        sync('[data-dsh-glass-settings-label]', labels.settings)
        return
      }
      const control = document.createElement('div')
      control.dataset.dshGlassControls = 'true'
      control.style.cssText = 'flex-direction:column;gap:10px;padding:16px 0;display:flex'
      control.innerHTML =
        '<div style="color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px" data-dsh-glass-title></div>' +
        '<div style="display:flex;flex-direction:column;gap:10px">' +
          '<div style="display:flex;flex-direction:column;gap:4px">' +
            '<div style="display:flex;align-items:center;gap:12px">' +
              '<span style="color:var(--dsw-alias-label-secondary);font-size:13px;flex:1" data-dsh-glass-main-label></span>' +
              '<input type="range" min="20" max="60" step="1" data-dsh-glass-main style="flex:1;cursor:pointer;-webkit-appearance:none;appearance:none;height:6px;border-radius:999px;outline:none;background:linear-gradient(90deg,#4176e6 var(--dsh-main-fill,35%),rgba(65,118,230,0.22) var(--dsh-main-fill,35%));box-shadow:inset 0 0 0 1px rgba(65,118,230,0.25)">' +
              '<span style="color:var(--dsw-alias-label-secondary);font-size:12px;min-width:40px;text-align:right" data-dsh-glass-main-val></span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:12px">' +
              '<span style="color:var(--dsw-alias-label-secondary);font-size:13px;flex:1" data-dsh-glass-settings-label></span>' +
              '<input type="range" min="20" max="60" step="1" data-dsh-glass-settings style="flex:1;cursor:pointer;-webkit-appearance:none;appearance:none;height:6px;border-radius:999px;outline:none;background:linear-gradient(90deg,#4176e6 var(--dsh-settings-fill,35%),rgba(65,118,230,0.22) var(--dsh-settings-fill,35%));box-shadow:inset 0 0 0 1px rgba(65,118,230,0.25)">' +
              '<span style="color:var(--dsw-alias-label-secondary);font-size:12px;min-width:40px;text-align:right" data-dsh-glass-settings-val></span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<style>' +
          '[data-dsh-glass-controls] input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #4176e6;box-shadow:0 1px 4px rgba(15,20,35,0.35),0 0 0 3px rgba(65,118,230,0.18);transition:box-shadow 0.15s ease,transform 0.15s ease;cursor:pointer}' +
          '[data-dsh-glass-controls] input[type=range]:hover::-webkit-slider-thumb{box-shadow:0 1px 6px rgba(15,20,35,0.4),0 0 0 5px rgba(65,118,230,0.22)}' +
          '[data-dsh-glass-controls] input[type=range]:active::-webkit-slider-thumb{transform:scale(1.1)}' +
          '[data-dsh-glass-controls] input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #4176e6;box-shadow:0 1px 4px rgba(15,20,35,0.35);cursor:pointer}' +
          '[data-dsh-glass-controls] input[type=range]::-moz-range-track{height:6px;border-radius:999px;background:linear-gradient(90deg,#4176e6 var(--dsh-main-fill,35%),rgba(65,118,230,0.22) var(--dsh-main-fill,35%))}' +
        '</style>'
      const titleEl = control.querySelector('[data-dsh-glass-title]')
      if (titleEl !== null) titleEl.textContent = labels.title
      const sync = (sel, text) => {
        const el = control.querySelector(sel)
        if (el !== null) el.textContent = text
      }
      sync('[data-dsh-glass-main-label]', labels.main)
      sync('[data-dsh-glass-settings-label]', labels.settings)
      const mainSlider = control.querySelector('[data-dsh-glass-main]')
      const settingsSlider = control.querySelector('[data-dsh-glass-settings]')
      const mainValEl = control.querySelector('[data-dsh-glass-main-val]')
      const settingsValEl = control.querySelector('[data-dsh-glass-settings-val]')
      if (mainSlider === null || settingsSlider === null || mainValEl === null || settingsValEl === null) return
      const renderMain = () => {
        mainSlider.value = String(mainVal)
        mainValEl.textContent = mainVal + '%'
        mainSlider.style.setProperty('--dsh-main-fill', ((mainVal - 20) / 40 * 100).toFixed(1) + '%')
      }
      const renderSettings = () => {
        settingsSlider.value = String(settingsVal)
        settingsValEl.textContent = settingsVal + '%'
        settingsSlider.style.setProperty('--dsh-settings-fill', ((settingsVal - 20) / 40 * 100).toFixed(1) + '%')
      }
      mainSlider.addEventListener('input', () => {
        mainVal = Math.round(Number(mainSlider.value))
        write(KEYS.main, mainVal)
        renderMain()
        applyVars()
      })
      settingsSlider.addEventListener('input', () => {
        settingsVal = Math.round(Number(settingsSlider.value))
        write(KEYS.settings, settingsVal)
        renderSettings()
        applyVars()
      })
      renderMain()
      renderSettings()
      const holder = panel.querySelector('[data-dsh-theme-glass-slot]') || panel
      holder.appendChild(control)
    }
    applyVars() // apply persisted values on every injection, panel open or not
    mount()
    const obs = new MutationObserver(mount)
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
    const obs = new MutationObserver(() => {
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
    })
    obs.observe(document.body, { childList: true, subtree: true })
    ensureCell()
    window.__dshThemeSettings = {
      cleanup: () => { obs.disconnect(); if (healTimer !== null) clearTimeout(healTimer); closePanel() },
    }
  })()`
}
