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

export const DEFAULT_ALPHA = 0
export const DEFAULT_THEME: GlassTheme = 'system'

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
    // Markdown / tool-call output code blocks: DSH fills them with an OPAQUE
    // deep color (--dsw-alias-markdown-code-block / -banner), so the command+
    // output frames read as solid black slabs. Repoint both to the same
    // translucent glass tint as the other surfaces so they join the frosted
    // family (they still blur through the center column's backdrop).
    '--dsw-alias-markdown-code-block': `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`,
    '--dsw-alias-markdown-code-block-banner': `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`,
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
        const titleEl = existing.querySelector('[data-dsh-alpha-title]')
        if (titleEl !== null && titleEl.textContent !== title) titleEl.textContent = title
        return
      }
        const control = document.createElement('div')
        control.dataset.dshGlassAlpha = 'true'
        control.style.cssText = 'flex-direction:column;gap:8px;padding:16px 0;display:flex'
        control.innerHTML =
          '<div style="display:flex;align-items:center;gap:12px;padding-left:12px">' +
            '<span style="color:var(--dsw-alias-label-secondary);font-size:13px;flex:1" data-dsh-alpha-title></span>' +
            '<input type="range" min="0" max="1" step="0.05" style="flex:1;cursor:pointer;-webkit-appearance:none;appearance:none;height:6px;border-radius:999px;outline:none;background:linear-gradient(90deg,#4176e6 var(--dsh-alpha-fill,0%),rgba(65,118,230,0.22) var(--dsh-alpha-fill,0%));box-shadow:inset 0 0 0 1px rgba(65,118,230,0.25)">' +
            '<span style="color:var(--dsw-alias-label-secondary);font-size:12px;min-width:40px;text-align:right" data-dsh-alpha-val></span>' +
          '</div>' +
          '<div data-dsh-cursor-fx style="flex-direction:column;gap:10px;display:flex;margin-top:8px">' +
            '<div style="color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px">光标特效</div>' +
            '<label style="display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer;padding-left:12px">' +
              '<input type="checkbox" style="width:15px;height:15px;accent-color:#4176e6;cursor:pointer">' +
              '<span>启用</span>' +
            '</label>' +
            '<div style="display:flex;align-items:center;gap:10px;padding-left:12px">' +
              '<span style="color:var(--dsw-alias-label-secondary);font-size:13px;min-width:52px">侧边栏</span>' +
              '<select data-dsh-fx-sidebar style="flex:1;background:rgb(39,46,62);color:var(--dsw-alias-label-primary);border:none;border-radius:18px;padding:6px 12px;font-size:13px;cursor:pointer;outline:none">' +
                '<option value="star">星星</option>' +
                '<option value="water">吐水</option>' +
                '<option value="snow">雪花</option>' +
                '<option value="spark">火花</option>' +
                '<option value="none">关闭</option>' +
              '</select>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:10px;padding-left:12px">' +
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
            '[data-dsh-glass-alpha] input[type=range]::-moz-range-track{height:6px;border-radius:999px;background:linear-gradient(90deg,#4176e6 var(--dsh-alpha-fill,0%),rgba(65,118,230,0.22) var(--dsh-alpha-fill,0%))}' +
          '</style>'
        const titleEl = control.querySelector('[data-dsh-alpha-title]')
        if (titleEl !== null) titleEl.textContent = title
        const input = control.querySelector('input[type=range]')
        const label = control.querySelector('[data-dsh-alpha-val]')
        if (input === null || label === null) return
        const render = (value) => {
          label.textContent = Math.round(value * 100) + '%'
          const pct = value * 100
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
          const clamped = Math.min(1, Math.max(0, value))
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
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => { pending = false; mount() })
    }
    const obs = new MutationObserver(schedule)
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
      // Glass blur recipes, one per surface family, so the blur radius and
      // saturation live in ONE place instead of being repeated in every rule.
      // --dsh-glass-*-blur are set dynamically on body by glassControlsScript;
      // these aliases MUST also be declared on body (NOT :root): a custom
      // property is resolved at the element that declares it, so on :root the
      // body-level --dsh-glass-*-blur would be invisible and the 界面模糊/弹窗模糊
      // sliders would no-op (regression fixed). Every consumer below is a
      // descendant of body, so body-scoped aliases reach them all.
      // The 主界面毛玻璃 slider drives main/settings/input/columns together,
      // the 弹出层 slider drives popup alone; the column recipe keeps the
      // 150% saturation chosen for the sidebar/center cards (用户: 饱和度150%).
      'body { --dsh-glass-main-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(140%); --dsh-glass-popup-filter: blur(var(--dsh-glass-popup-blur, 40px)) saturate(140%); --dsh-glass-column-filter: blur(var(--dsh-glass-main-blur, 24px)) saturate(150%); }',
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
      // Conversation header (session title + 对话/轨迹 tabs + 标准模式):
      // a floating glass card rounded on all four corners, matching the
      // sidebar/center cards. Its glass follows the SIDEBAR slider (per
      // user preference), so it stays visible even when the main-surface
      // slider is low.
      // NOTE: glass goes on a ::before overlay, NOT on the header itself —
      // backdrop-filter makes the element a containing block for fixed
      // descendants, which re-anchored the Session log floating button
      // (position:fixed, JS-set left) from the viewport into the header and
      // shifted it under the composer stats row (unclickable).
      // NOTE 2: the header rides INSIDE the center column, whose own ::before
      // frosts the whole column (single blur + saturate(150%)). The header's
      // ::before therefore carries NO backdrop-filter — it would stack a
      // second pass and make the card deeper than the sidebar (用户: 都改成
      // 1次模糊). It keeps only its translucent fill (the SIDEBAR slider); the
      // column's single pass is exactly the header's single pass, so the
      // header, the sidebar and the center all read as one 1×blur +
      // saturate(150%) glass family.
      '[class*=\"_centerCol\"] header {',
      '  position: relative !important;',
      '  background: transparent !important;',
      '  border-radius: 14px !important;',
      '  margin: 6px 10px 0 !important;',
      // NOTE: no overflow:hidden here — it clipped the 后台任务 jobs menu
      // (QsffPG_menu, absolute below the trigger) because the menu extends
      // past the header's box; the header::after hairline that overflow used
      // to clip is already display:none below, and background follows
      // border-radius on its own, so nothing regresses visually.
      '}',
      '[class*=\"_centerCol\"] header::before {',
      '  content: \"\" !important;',
      '  position: absolute !important;',
      '  inset: 0 !important;',
      '  border-radius: inherit !important;',
      '  pointer-events: none !important;',
      '  z-index: -1 !important;',
      '  background: var(--dsh-glass-sidebar-bg, rgba(15,17,23,0.35)) !important;',
      // NO backdrop-filter here: the center column's ::before is the header's
      // single 1×blur + saturate(150%) pass (see NOTE 2 above).
      '}',
      // The SPA paints a 1px white hairline (header::after) along the bottom
      // edge — with the floating glass card it reads as a stray bright line.
      '[class*=\"_centerCol\"] header::after { display: none !important; }',
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
      // NOTE: no brand-svg 260px width rule here anymore — rc.8 splits the
      // brand into an icon svg (brandMark, 24px) and a wordmark svg
      // (brandName, 156px); forcing 260px blew both up and the overflow:hidden
      // button clipped them. Original sizes render correctly.
      // The SPA's root is 12px wider than the sidebar column, which pushes the
      // logo row flush against the right edge while leaving 12px on the left.
      // Shift it 6px left and pin the width so the row centers in the column
      // (6px each side) — in a flex container a bare margin-left alone makes
      // the row re-grow and stay flush right.
      '[class*=\"_sidebarCol\"] [class*=\"_root\"]:not([class*=\"_collapsed\"]) [class*=\"_logoRow\"] {',
      '  height: 75px !important;',
      '  width: 256px !important;',
      '  margin-bottom: 6px !important;',
      '  margin-left: -6px !important;',
      '  padding-top: 6px !important;',
      '  padding-bottom: 6px !important;',
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
      // (an OPAQUE deep blue-gray). The 输入框毛玻璃 slider (主题设置 → 界面
      // 毛玻璃) controls this independently: base rgb(39,46,62) at a user
      // alpha 20..100% (100% = that blue-gray, lower = more translucent
      // frosted glass with blur). The blur rides the same radius as the other
      // glass surfaces.
      // Once the seat is floated out of the scroll body (see
      // keepComposerFloating) the card's parent is a flex column that
      // stretches it to the full center-column width; restore the historical
      // centered 780px width.
      // The composer card hosts the popup MENUS (_sideTop_/_menu/_list_) as
      // children. Chromium drops a child's backdrop-filter when an ancestor
      // has one (the child samples the ancestor's composited result — the
      // nested blur never renders; verified: menu blur 100px vs 0px
      // pixel-identical while the card carried a backdrop-filter). So the
      // card itself keeps only its translucent tint: the menus' own blur
      // works, and the 30% tint over the already-frosted column reads the
      // same. Its backdrop-filter is intentionally omitted.
      '[class*=\"uV2eYG_card\"] { width: 780px !important; max-width: calc(100% - 16px) !important; margin-left: auto !important; margin-right: auto !important; background-color: var(--dsh-glass-input-bg, rgb(39,46,62)) !important; }',
      // Queued-message dock (插话发送, _7yHdaG_dock): its width follows the
      // SPA's --dsh-composer-card-max-width default, which renders narrower
      // than the 780px input card the user sees (user: 太窄了). Pin it to the
      // same 780px centered width so it aligns with the composer card.
      '[class*=\"_7yHdaG_dock\"] { width: 780px !important; max-width: calc(100% - 16px) !important; margin-left: auto !important; margin-right: auto !important; }',
      // Task-list dock (任务清单, TodoPanel root lXshSW_root): renders above the
      // composer while a task list is active. Its own rule caps the width at
      // calc(card-max-width - 4*dock-inset), so it renders NARROWER than the
      // 780px input card (user: 任务这个弹窗很窄 能不能跟输入框一样宽). Pin it to
      // the same 780px centered width so it aligns with the composer card and
      // the queued-message dock. The inner body/list already stretch to it.
      '[class*=\"lXshSW_root\"] { width: 780px !important; max-width: calc(100% - 16px) !important; }',
      // Composer 命令 (+) 按钮: DSH 给它 --dsw-specific-selector (opaque
      // #353638 深灰圆点), 与同排的访问模式/模型/上下文透明按钮不协调。
      // 改为透明, 让图标直接浮在输入卡片的玻璃上; 悬停态同样去灰。
      '[class*=\"uV2eYG_add\"] { background: transparent !important; }',
      '[class*=\"uV2eYG_add\"]:hover:not(:disabled) { background: rgba(128,132,142,0.18) !important; }',
      // Task progress strip above the composer (lXshSW_root) and user message
      // bubbles (_bubble): DSH paints both with OPAQUE neutrals (task tip
      // rgb(53,54,56), bubble rgb(44,44,46)) that read as solid slabs next to
      // the frosted input card. Repaint both with the same frosted glass as
      // the input card (alpha 0.35 + blur, inside each box only) so the strip
      // and sent messages match the composer family.
      '[class*=\"lXshSW_root\"], [class*=\"_bubble\"] { background: var(--dsh-glass-main-bg, rgba(15,17,23,0.35)) !important; backdrop-filter: var(--dsh-glass-main-filter) !important; -webkit-backdrop-filter: var(--dsh-glass-main-filter) !important; }',
      // Inline code in messages: DSH paints it with an OPAQUE dark neutral
      // (rgb(44,44,46)) that reads as a black slab on the frosted bubbles.
      // Repaint it with translucent blue-gray glass — the same tone as the
      // input card and popups (rgb(39,46,62)) — so code reads as a frosted
      // chip on the glass family instead of a solid black block.
      'code { background-color: rgba(39,46,62,0.4) !important; }',
      // Composer popup menus (model / access-mode / command pickers, e.g.
      // _7KE1Ra_menu, _3e4SsG_menu) and the access-mode / reasoning-level
      // list popups (_sideTop_ list, which lives inside the input card):
      // blue-gray rgba(39,46,62) — the same tone as the input card, per user
      // request. Frosted look follows the SIDEBAR recipe the user pointed at:
      // a light 7% tint over the wallpaper, no grain — the sidebar reads as
      // naturally frosted exactly because the wallpaper dominates and there is
      // no texture (noise grain was rejected: 力度太大 不正常). The 弹出层
      // slider runs 5..100 in 主题设置 → 界面毛玻璃 (default 7, mirroring the
      // sidebar's alpha; 100 = fully solid slab). The _sideTop_ class
      // is unique to the access-mode list (one match). The queued-message
      // dock that appears above the composer while the agent is running is
      // NOT part of this popup family — it is the queued-message dock
      // (插话发送, _7yHdaG_dock) and gets the INPUT-card glass treatment
      // below, so it reads as the same family as the composer card it sits
      // above (its default popup-family alpha of 0.07 was nearly transparent
      // and looked unfrosted, user: 背景没有磨砂效果). The context-usage popup
      // (上下文已用, JObwrW_panel) rides the same variable via
      // --dsw-specific-menu and joins the family.
      '[class*=\"_menu\"], [class*=\"_sideTop_\"], [class*=\"JObwrW_panel\"], [class*=\"_list_\"], [class*=\"_submenu_\"] { background-color: var(--dsh-glass-popup-bg, rgba(39,46,62,0.07)) !important; backdrop-filter: var(--dsh-glass-popup-filter) !important; -webkit-backdrop-filter: var(--dsh-glass-popup-filter) !important; }',
      // Queued-message dock (插话发送, _7yHdaG_dock) sits ABOVE the composer
      // card; give it the SAME input-card glass (input-bg + main blur) and the
      // composer's 22px radius on ALL corners (the SPA paints the panel with
      // --dsw-specific-tip opaque gray and a top-only 12px radius + a
      // half-border ::after — user: 倒圆角没做好). Round all corners to match
      // the composer card and kill the stray half-border; the frosted blur
      // (which popup-family's near-transparent alpha dropped) makes the dock
      // read as one glass surface with the card below it.
      '[class*=\"_7yHdaG_dock\"] { background-color: transparent !important; }',
      '[class*=\"_7yHdaG_panel\"] { background-color: var(--dsh-glass-input-bg, rgb(39,46,62)) !important; backdrop-filter: var(--dsh-glass-main-filter) !important; -webkit-backdrop-filter: var(--dsh-glass-main-filter) !important; border-radius: 22px !important; }',
      '[class*=\"_7yHdaG_panel\"]::after { display: none !important; }',
      // Sidebar session hover-preview card (CSS-modules class _card_<hash>_<n>)
      // paints an OPAQUE rgb(44,44,46) with no blur — a solid slab over the
      // glass. Scanned the page: the hover preview card is the only _card_
      // floating layer (body-direct, so the broad selector cannot hit in-tree
      // cards). Same popup family treatment, but MORE transparent than the
      // popup slider default (user: 鼠标停留弹出的框没有模糊和透明 / 可以再透明点);
      // the wildcard keeps it working across web upgrades that re-hash the class.
      'body > [class*=\"_card_\"] { background-color: rgba(39,46,62,0.45) !important; backdrop-filter: var(--dsh-glass-popup-filter) !important; -webkit-backdrop-filter: var(--dsh-glass-popup-filter) !important; }',
      // While the agent is answering, the center column repaints on every
      // token; the sidebar hover-preview card's backdrop-filter (above)
      // re-samples that moving backdrop each frame, and the compositor
      // flashes a stale backdrop — the visible flicker right of the sidebar
      // during streaming. streamingGuardScript flips html[data-dsh-streaming];
      // while set, suspend the card's blur (the translucent tint stays) so it
      // stops re-blurring. Idle hovers keep the full frosted look.
      'html[data-dsh-streaming] body > [class*=\"_card_\"] { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',
      // Settings-panel selector dropdowns (标准模式 / Full access / 语言 /
      // 排队发送 pickers) use the shared portal-list component (CSS-modules
      // group _list_ / _submenu_) which paints --dsw-specific-menu as an
      // OPAQUE blue-gray slab. Their popup glass joins the composer-menu
      // family above (merged selector in the _menu_/_sideTop_ rule).
      // Settings-panel nav item (通用设置/模型/插件/Agent 预设/插件市场/主题设置):
      // DSH paints hover/active with --dsw-specific-sidebar-nav-item-hover/-active,
      // OPAQUE neutral grays (#2c2c2e / #43454a) that read as solid gray slabs
      // on the frosted settings panel (user: 背景颜色是灰色的, 跟毛玻璃不匹配).
      // Repaint both with translucent blue-gray frosted glass — same tone as
      // the input card — so the selected nav item reads as a glass chip.
      '[class*=\"VOzbGW_navCell\"]:hover { background-color: rgba(39,46,62,0.35) !important; }',
      '[class*=\"VOzbGW_navCell\"][class*=\"VOzbGW_active\"] { background-color: rgba(39,46,62,0.55) !important; }',
      // Settings-panel form controls (光标特效 icon pickers 侧边栏/右侧, 标题
      // 颜色切换时间 seconds input): DSH paints them with
      // --dsw-alias-bg-layer-3 (OPAQUE rgb(39,46,62)) so they read as solid
      // blue-gray slabs on the frosted panel (user: 颜色也不对). Repaint them
      // with translucent blue-gray glass — same family as the nav chips — so
      // the controls join the glass theme. Native popup lists stay dark
      // because the panel already sets color-scheme: dark.
      '[class*=\"VOzbGW_options\"] select, [class*=\"VOzbGW_options\"] input[type=\"number\"] { background-color: rgba(39,46,62,0.45) !important; }',
      // Settings-panel selector buttons (标准模式 / Full access / 语言 / 排队
      // 发送): DSH paints them with --dsw-alias-bg-module-platform (OPAQUE
      // rgb(39,46,62)), so the resting button is a solid blue-gray block while
      // the popup it opens is already frosted (user: 默认的颜色是没修改的 只有
      // 点击后 颜色是修改后的). Repaint with the same translucent glass as the
      // other controls so button and popup read as one family.
      '[class*=\"_selector\"] { background-color: rgba(39,46,62,0.45) !important; }',
      // 光标特效 icon pickers (原生 <select>, 侧边栏/右侧): the settings row
      // flex-stretches them to the full panel width (~484px, user: 太长了).
      // Cap the width and pin them to the right edge of their row
      // (margin-left:auto absorbs the free space; flex:0 0 auto overrides the
      // SPA's inline flex:1 so the cap actually holds).
      '[class*=\"VOzbGW_options\"] select { max-width: 200px !important; flex: 0 0 auto !important; margin-left: auto !important; }',
      // 设置面板全屏遮罩(VOzbGW_mask)渐显:DSH 原生写的是 transition:all(无
      // 时长=0s),遮罩一帧内全屏出现/消失,点设置时表现为整屏闪暗/闪亮。打开
      // 侧补 0.18s fade-in;关闭侧 DOM 直接移除,CSS 过渡无从谈起,由下方
      // maskFadeKeeper 在移除同帧追加渐隐替身层补 fade-out。
      '@keyframes dshMaskIn { from { opacity: 0 } to { opacity: 1 } }',
      '@keyframes dshMaskOut { from { opacity: 1 } to { opacity: 0 } }',
      '[class*=\"VOzbGW_mask\"] { animation: dshMaskIn 0.18s ease-out !important; }',
      // Scroll-to-bottom floating button (回到底部, Md3f7G_toBottom, rides
      // inside the sticky Md3f7G_toBottomSlot): DSH paints it with
      // --dsw-alias-button-floating-fill (rgb(32,38,52), too dark on the
      // glass canvas). Repaint it as frosted blue-gray glass (same family as
      // the input card) with a translucent border so it reads as a glass
      // chip instead of a solid dark dot. [class~=] matches the exact token,
      // so the zero-height slot container is left alone.
      '[class~=\"Md3f7G_toBottom\"] { background: rgba(39,46,62,0.55) !important; backdrop-filter: blur(24px) saturate(140%) !important; -webkit-backdrop-filter: blur(24px) saturate(140%) !important; border-color: rgba(255,255,255,0.18) !important; }',
      '[class~=\"Md3f7G_toBottom\"]:hover { background: rgba(39,46,62,0.72) !important; }',
      // User feedback: the floating button sat ~170px above the composer,
      // too high. Drop it down so it hugs the input card (transform doesn't
      // disturb the sticky layout, it just shifts the visual position).
      '[class~=\"Md3f7G_toBottom\"] { transform: translateY(88px) !important; }',
      // The whole MAIN surface (everything except the settings panel): the
      // sidebar and the center conversation column get the same frosted glass
      // as the composer (driven by the 主界面毛玻璃 slider), so the whole
      // window reads as one glass family instead of a translucent pane with a
      // few frosted islands. Both classes are stable layout suffixes (one
      // match each); a blanket [class*="_root"] under the center column would
      // hit every message/tool-call block.
      //
      // The SIDEBAR cannot carry the backdrop-filter on the column itself:
      // the hosted settings panel lives in its footer (footArea →
      // settingsArea → VOzbGW_overlay), and a backdrop-filter on the column
      // turns it into the containing block for that fixed overlay, collapsing
      // the settings page to the 268px column width. Instead the blur rides a
      // ::before pseudo-element: it spans the WHOLE column (so the background
      // is uniform from the logo row to the footer — no more visible seam
      // above the settings button), yet a pseudo-element is not a DOM
      // ancestor, so the overlay's containing block stays the viewport.
      '[class*=\"_centerCol\"] { position: relative !important; background-color: var(--dsh-glass-main-bg, rgba(15,17,23,0.35)) !important; }',
      // The center column's blur rides a ::before pseudo-element (same
      // pattern as the sidebar), NOT the column itself: a backdrop-filter on
      // the element forces the compositor to re-sample everything below it
      // whenever the ambient layer animates, re-rasterizing the whole column
      // (text included) every frame — the "whole interface flickers" bug.
      // On the pseudo-element the sampled layer is separate from the content
      // layer, so ambient animation never repaints the messages.
      '[class*=\"_centerCol\"]::before, [class*=\"_sidebarCol\"]::before { content: \"\" !important; position: absolute !important; inset: 0 !important; border-radius: inherit !important; pointer-events: none !important; z-index: -1 !important; backdrop-filter: var(--dsh-glass-column-filter) !important; -webkit-backdrop-filter: var(--dsh-glass-column-filter) !important; }',
      // The center column's inner root (wSkVaW_root) keeps the SPA's own
      // rgba(15,17,23,0.224) fill, stacking ANOTHER translucent layer on top
      // of the --dsh-glass-main-bg on the column — so at low main-surface
      // values the center reads noticeably more opaque than the sidebar.
      // Clear it; the column's own variable background is the single glass
      // layer, matching the sidebar.
      '[class*=\"_centerCol\"] [class*=\"wSkVaW_root\"] { background-color: transparent !important; }',
      '[class*=\"_sidebarCol\"] { position: relative !important; z-index: 1 !important; background-color: var(--dsh-glass-sidebar-bg, rgba(15,17,23,0.35)) !important; }',
      // The composer stats line under the input (FJxK0a_root: "4 轮 · 1294 步|
      // LLM 160m …| 输入 358M tok · 输出 …"): SPA renders it nowrap inside an
      // overflow:hidden box, so at narrow widths the tail ("输出 … tok") is
      // clipped. Allow wrapping and let the composer root grow so the whole
      // line is always visible.
      '[class*=\"FJxK0a_root\"] { white-space: normal !important; overflow: visible !important; height: auto !important; }',
      '[class*=\"uV2eYG_root\"] { height: auto !important; min-height: 94px !important; }',
      // The sidebar's ::before rides the SAME single-pass frosted backdrop as
      // the center column (and the 对话/轨迹 header card on top of it): one
      // blur + saturate(150%). One pass keeps the sidebar exactly as deep as
      // the header — the header's single pass comes from the center column's
      // ::before, and the sidebar lists the same single blur+saturate(150%)
      // so all three regions read as one glass family (用户: 都改成1次模糊, 饱和
      // 度150%). (The saturate was dropped earlier because at OPAQUE navy
      // alpha it boosted the blue channel; over the wallpaper it just
      // saturates the texture, and 150% is the chosen depth.)
      // (The ::before blur itself is the merged selector in the centerCol
      // rule above — same declaration, one place to edit.)
      // Hosted settings panel (VOzbGW_panel, tagged data-dsh-settings-panel by
      // themeSettingsScript): DSH paints it with an OPAQUE blue-gray
      // (rgb(32,38,52)). Give the SETTINGS surface its own frosted glass,
      // driven by the 设置界面毛玻璃 slider, so it reads as glass like the
      // main UI instead of a solid slab.
      '[data-dsh-settings-panel] { background-color: var(--dsh-glass-settings-bg, rgba(15,17,23,0.35)) !important; backdrop-filter: var(--dsh-glass-main-filter) !important; -webkit-backdrop-filter: var(--dsh-glass-main-filter) !important; }',
      // "确认启用 Full access？" 确认弹窗 (_confirmation_<hash>_<n>，由 通用设置
      // → 权限 选择 Full access 触发): DSH 用 OPAQUE rgb(32,38,52) 画卡片且无
      // blur——一块实心灰板。改用弹出层毛玻璃(同下拉菜单/悬浮卡家族)，让确认
      // 弹窗融入玻璃主题。透明度用固定值(0.35)而非 --dsh-glass-popup-bg：遮罩
      // 兄弟层(_mask_)已压暗到 50% 黑，若随弹出层滑块到 0.07 会透明得几乎看不
      // 到卡片边界；固定 0.35 保证毛玻璃卡清晰浮在压暗页面上，模糊仍跟随弹出层
      // 滑块。遮罩本身保留暗色。
      '[class*="_confirmation_"] { background-color: rgba(39,46,62,0.35) !important; backdrop-filter: var(--dsh-glass-popup-filter) !important; -webkit-backdrop-filter: var(--dsh-glass-popup-filter) !important; }',
      // Tool-call output (Bash etc.) code blocks: DSH fills them with
      // --dsw-alias-markdown-code-block (opaque) and the banner with
      // --dsw-alias-markdown-code-block-banner (opaque). Repaint both with the
      // glass alpha so the popped-out command/output frame matches the panes.
      // The banner sits on the block, so give it one extra translucent layer
      // to stay slightly distinct while still reading as glass.
      '[class*=\"_block_178r4_4\"], [class*=\"_block_10eou_7\"], [class*=\"_block_biesw_7\"], [class*=\"_block_srovd_7\"], [class*=\"_block_s66q0_7\"] { background: var(--dsw-specific-panel-fill, rgba(15,17,23,0.224)) !important; backdrop-filter: blur(18px) saturate(150%) !important; -webkit-backdrop-filter: blur(18px) saturate(150%) !important; }',
      '[class*=\"_bannerWrap_178r4_21\"] { background-color: var(--dsw-specific-panel-fill, rgba(15,17,23,0.224)) !important; }',
      '[class*=\"_banner_178r4_21\"], [class*=\"_banner_biesw_21\"], [class*=\"_header_10eou_38\"] { background-color: var(--dsw-specific-panel-fill, rgba(15,17,23,0.224)) !important; }',
      // Tool-output block width: Ctrl + mouse wheel over a tool-call output
      // block adjusts the width of its output lines. The width rides a
      // --dsh-output-width variable (a percentage of the container), set +
      // persisted by the wheel handler below; default 100% = the block's
      // native full width, so with no adjustment nothing changes. Narrower
      // values wrap the pre's long lines earlier; the block keeps auto
      // horizontal margins so it stays centred as it shrinks.
      // Target the OUTER tool-call row and the markdown code-fence blocks
      // (_block_*). Tool calls NEST ztWv_q_callRow (an outer row wraps
      // sub-call rows), so constraining EVERY row would compound the shrink
      // (each % of the previous). The :not(...) descendant guard keeps the
      // max-width on the OUTERMOST row only; inner rows follow it by layout.
      // max-width not width, so a wider-than-container value lets the block
      // overflow (long lines read full-width) without pushing the column.
      '[class*=\"ztWv_q_callRow\"]:not([class*=\"ztWv_q_callRow\"] [class*=\"ztWv_q_callRow\"]), [class*=\"Sxvs8a_root\"], [class*=\"_block_178r4_4\"], [class*=\"_block_10eou_7\"], [class*=\"_block_biesw_7\"], [class*=\"_block_srovd_7\"], [class*=\"_block_s66q0_7\"] { max-width: var(--dsh-output-width, 100%) !important; margin-left: auto !important; margin-right: auto !important; }',
      '[class*=\"_block_178r4_4\"] :where(pre), [class*=\"_block_10eou_7\"] :where(pre), [class*=\"_block_biesw_7\"] :where(pre) { width: 100% !important; }',
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
    // rc.8 splits the brand into TWO svgs: the icon (brandMark, first) and the
    // wordmark letters (brandName, second). Give each its own gradient id so
    // the letter paths cycle colors too, not just the icon.
    const brandGradId = (idx) => (idx === 0 ? 'dsh-logo-grad' : 'dsh-logo-grad-name')
    // Repoint every brand letter path at the gradient. rc.8 has two flavors:
    // the "DeepSeek" letters use fill="currentColor", while the "HARNESS"
    // badge letters (inside g[clip-path*="badge"]) get the INVERTED high-
    // contrast treatment: white letters on a COLOR-CYCLING dark pill. The
    // original design tinted the badge with the same gradient at 28% opacity
    // and gave the letters the same gradient — at this 14px size the letters
    // had almost no contrast against the tinted pill (luminance 44–58, edge
    // energy 0.45) and read as a smudged slab (user: HARNESS 显示不清晰).
    // The badge now fills with the SAME cycling gradient as DeepSeek at full
    // opacity, dimmed by a CSS brightness(0.45) filter so the gradient still
    // changes color with the brand cycle while the white letters stay crisp
    // on every stop (luminance 52–255, edge energy 34, verified by A/B) —
    // user: HARNESS 背景可以变色 看看效果.
    const repointLetterFills = (svg, gradId) => {
      svg.querySelectorAll('path[fill="currentColor"]').forEach((p) => {
        p.setAttribute('fill', 'url(#' + gradId + ')')
      })
      // HARNESS badge letters: SOLID WHITE (see comment above).
      svg.querySelectorAll('g[clip-path*="badge"] path').forEach((p) => {
        p.setAttribute('fill', '#ffffff')
      })
      // HARNESS badge backdrop: the cycling gradient at full opacity, dimmed
      // with brightness(0.45) — half the contrast fix (see comment above).
      svg.querySelectorAll('rect[fill="currentColor"]').forEach((r) => {
        r.setAttribute('fill', 'url(#' + gradId + ')')
        r.setAttribute('fill-opacity', '1')
        r.style.filter = 'brightness(0.45)'
      })
    }
    const ensureLogoStructure = () => {
      const svgs = document.querySelectorAll('[class*="_brand"] svg')
      if (svgs.length === 0) return
      const NS = 'http://www.w3.org/2000/svg'
      svgs.forEach((svg, idx) => {
        const gradId = brandGradId(idx)
        const grad = svg.querySelector('linearGradient[id="' + gradId + '"]')
        if (grad !== null) {
          // Gradient survives, but the re-render may have reset letter fills
          // back to currentColor; repoint them regardless.
          repointLetterFills(svg, gradId)
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
        repointLetterFills(svg, gradId)
      })
    }

    const applyLogoStructure = ensureLogoStructure

    // Repaint the wordmark gradient and whale rect with current colors.
    // rc.8: repaint BOTH brand svgs (icon + wordmark letters) with their own
    // gradient ids, so the letters cycle colors along with the icon. Each svg
    // is judged by its own gradient stops, not the shared cache, so a color
    // change repaints every svg exactly once.
    const applyLogo = () => {
      const svgs = document.querySelectorAll('[class*="_brand"] svg')
      if (svgs.length === 0) return
      const NS = 'http://www.w3.org/2000/svg'
      const stopsMatch = (grad) => {
        const kids = grad.children
        if (kids.length !== gradColors.length) return false
        for (let i = 0; i < kids.length; i++) {
          if (kids[i].getAttribute('stop-color') !== gradColors[i]) return false
        }
        return true
      }
      svgs.forEach((svg, idx) => {
        const gradId = brandGradId(idx)
        let grad = svg.querySelector('linearGradient[id="' + gradId + '"]')
        if (grad === null) {
          // Structure was dropped by a sidebar re-render: rebuild it and force
          // a repaint (the new gradient starts with no stops, so an early
          // return would leave it empty).
          ensureLogoStructure()
          grad = svg.querySelector('linearGradient[id="' + gradId + '"]')
          if (grad === null) return
        }
        if (grad.firstChild !== null && stopsMatch(grad)) return
        while (grad.firstChild !== null) grad.removeChild(grad.firstChild)
        gradColors.forEach((c, i) => {
          const stop = document.createElementNS(NS, 'stop')
          stop.setAttribute('offset', String((i * 100) / (gradColors.length - 1)) + '%')
          stop.setAttribute('stop-color', c)
          grad.appendChild(stop)
        })
        svg.querySelectorAll('rect').forEach((r) => {
          if (idx === 0 && r.getAttribute('fill') !== whaleColor) r.setAttribute('fill', whaleColor)
        })
      })
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
    // (主题设置 → 颜色切换时间, persisted in localStorage; default 10s);
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
    // 设置遮罩渐隐 keeper:mask 关闭时 DSH 直接移除 DOM(observer 微任务 →
    // rAF 都在下一帧渲染前跑),在移除后的首帧渲染前追加一个渐隐替身层,
    // 视觉上遮罩平滑淡出而非瞬间消失(整屏闪亮)。配合 CSS 侧 dshMaskIn,
    // 遮罩开关两个方向都有 0.18s 过渡。
    let lastMaskSeen = document.querySelector('[class*="VOzbGW_mask"]') !== null
    const maskFadeKeeper = () => {
      const mask = document.querySelector('[class*="VOzbGW_mask"]')
      if (mask !== null) { lastMaskSeen = true; return }
      if (!lastMaskSeen) return
      lastMaskSeen = false
      const ghost = document.createElement('div')
      ghost.setAttribute('data-dsh-mask-fade', '')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);pointer-events:none;z-index:9990;animation:dshMaskOut 0.18s ease-out forwards'
      document.body.appendChild(ghost)
      ghost.addEventListener('animationend', () => ghost.remove())
      setTimeout(() => ghost.remove(), 600)
    }
    const obsTick = () => {
      obsScheduled = false
      maskFadeKeeper()
      if (!document.head.contains(style)) {
        if (document.querySelector('#dsh-dt-style') === null) document.head.appendChild(style)
      }
      applyLogoStructure()
      applyLogo()
      applyRailFish()
      applySidebarIcons()
      stripComposerTitles()
      keepComposerFloating()
    }
    const obs = new MutationObserver(() => {
      // Brand (re)appearance is time-critical: rebuild its gradient structure
      // synchronously so collapse/expand never leaves the wordmark invisible
      // for even one frame. Everything else stays rAF-throttled.
      // rc.8: check BOTH brand svgs (icon + wordmark letters).
      const brandSvgs = document.querySelectorAll('[class*="_brand"] svg')
      let brandBroken = false
      brandSvgs.forEach((s, idx) => {
        if (s.querySelector('linearGradient[id="' + brandGradId(idx) + '"]') === null) brandBroken = true
      })
      if (brandSvgs.length > 0 && brandBroken) {
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

    // ── Float the composer OUT of the message scroll area ──
    // DSH lays the composer out as a STICKY child of the message scroll body,
    // so scrolled messages pass BEHIND the input box and show through a
    // translucent (frosted) input surface. Move the seat up to the center
    // column as an ABSOLUTE element pinned to its bottom: the seat is no
    // longer part of the scrollable content, the scroll area is shrunk to end
    // above it, and messages can never appear behind the input box — the
    // input keeps its true frosted-glass translucency. The center column's
    // backdrop-filter makes it the containing block, so the seat follows the
    // column's bottom (terminal dock open, window resize). React re-renders
    // put the seat back into the scroll body; obsTick (rAF-throttled) moves
    // it again, and the same pass re-pins the scroll height.
    // 会话切换时 React 找不到被挪走的 seat,会在 scroll 里重建一个新节点,
    // 旧节点成为孤儿(带钉底内联样式叠在页面底部,双输入框)——每帧先清
    // 僵尸。空会话(无消息)DSH 原生是输入框垂直居中的欢迎布局,钉底反而
    // 错(大片空白+输入框沉底):无内容时解钉,还原原生布局。
    const keepComposerFloating = () => {
      const center = document.querySelector('[class*="_centerCol"]')
      const scroll = document.querySelector('[class*="_centerCol"] [class*="_scrollBody"], [class*="_centerCol"] [class*="_scroll"]')
      if (center === null || scroll === null) return
      // 僵尸清理:seat 原生只住在 scroll 里。React 会话切换时在 scroll 重建
      // 新 seat,我们此前挪出去的旧节点成为孤儿——仅当 scroll 里确有原生
      // seat 时才删外面的孤儿(单节点在别处=正常钉底态,不能删)。
      const seats = document.querySelectorAll('[class*="wSkVaW_composerSeat"]')
      let seat = null
      for (const s of seats) if (s.parentElement === scroll) seat = s
      if (seats.length > 1 && seat !== null) {
        for (const s of seats) if (s.parentElement !== scroll) s.remove()
      }
      if (seat === null) seat = document.querySelector('[class*="wSkVaW_composerSeat"]')
      if (seat === null) return
      // 空会话检测:scroll 内除 seat 外无内容 → 原生居中布局。
      // 消息容器是 display:contents(无盒高),高度检测恒 0——改用
      // "有高度或有文本"判定:消息会话文本量大,空会话该容器无文本。
      const hasContent = [...scroll.children].some((c) =>
        c !== seat && (c.getBoundingClientRect().height > 4 || (c.textContent || '').trim().length > 0))
      if (!hasContent) {
        // 设置浮层打开时空会话欢迎界面隐藏:模态遮罩是半透明的,
        // 底下透出居中输入框与设置面板叠在一起,视觉混乱。
        const dialogOpen = document.querySelector('[role="dialog"]') !== null
        if (dialogOpen && seat.style.display !== 'none') seat.style.display = 'none'
        if (!dialogOpen && seat.style.display === 'none') seat.style.display = ''
        // 只在确有钉底残留时清理(避免每次 DOM 变化都强制回流)。
        if (scroll.style.height !== '') {
          scroll.style.removeProperty('flex')
          scroll.style.removeProperty('height')
          scroll.style.removeProperty('min-height')
        }
        if (seat.style.position !== '') {
          if (seat.parentElement !== scroll) {
            seat.parentElement.removeChild(seat)
            scroll.appendChild(seat)
          }
          seat.style.removeProperty('position')
          seat.style.removeProperty('left')
          seat.style.removeProperty('right')
          seat.style.removeProperty('bottom')
          seat.style.removeProperty('margin')
          seat.style.removeProperty('z-index')
        }
        return
      }
      // 有内容(消息会话):确保 welcome 隐藏态被还原(切会话残留)。
      if (seat.style.display === 'none') seat.style.display = ''
      if (seat.parentElement !== center) center.appendChild(seat)
      seat.style.position = 'absolute'
      seat.style.left = '0'
      seat.style.right = '0'
      seat.style.bottom = '0'
      seat.style.margin = '0'
      seat.style.zIndex = '100'
      const sr = scroll.getBoundingClientRect()
      const st = seat.getBoundingClientRect()
      if (sr.top > 0 && st.top > 0) {
        const h = Math.max(80, Math.round(st.top - sr.top - 8))
        scroll.style.setProperty('flex', '0 0 auto', 'important')
        scroll.style.setProperty('height', h + 'px', 'important')
        scroll.style.setProperty('min-height', h + 'px', 'important')
      }
    }
    keepComposerFloating()

    // ── Center-column width: Ctrl + mouse wheel ──
    // Holding Ctrl and scrolling while the pointer is anywhere over the
    // center output column widens/narrows the ENTIRE column's display width
    // (not just one tool block). The width is applied as a fixed pixel value
    // on the grid template's middle track (replacing the elastic
    // minmax(0,1fr)), persisted in localStorage (dsh-desktop-center-width).
    // The listener is added once (guarded by a global so re-injections and
    // theme re-applies never stack a second copy); a full page reload clears
    // it with the JS context, so no explicit removal is needed.
    const CENTER_W_KEY = 'dsh-desktop-center-width'
    let centerW = 0 // 0 = unset, keep the DSH default elastic minmax(0,1fr)
    try {
      const saved = parseInt(localStorage.getItem(CENTER_W_KEY) || '0', 10)
      if (!Number.isNaN(saved) && saved > 0) centerW = saved
    } catch {}
    const frameEl = () => document.querySelector('[class*="pI_x6G_frame"]')
    const centerColEl = () => document.querySelector('[class*="pI_x6G_centerCol"]')
    const parseTracks = (gtc) => {
      // 3 tracks (sidebar / center / details). The middle track may itself
      // contain spaces (e.g. minmax(0px, 1fr)), so split by matching the
      // first and last whitespace-delimited tokens, leaving the middle whole.
      const m = /^\\S+\\s+(.*)\\s+\\S+$/.exec((gtc || '').trim())
      if (m === null) return null
      const first = (gtc || '').trim().match(/^\\S+/)[0]
      const last = (gtc || '').trim().match(/\\S+$/)[0]
      return { first, middle: m[1], last }
    }
    // 默认(未调整)中列宽度：网格处于弹性 minmax(0,1fr) 时中心列的渲染宽度，
    // 即窗口宽减侧边栏与右侧详情轨。它是 ctrl+滚轮的下限——用户要求缩小时
    // 中列不得低于"没改前"的默认宽度，只能往更宽调、再缩回默认为止。
    // 必须在 applyOnce 应用持久宽度之前读取，此时中列还是弹性值。
    // 用 let：onOutWheel 会在布局变化后刷新下限（const 会在运行时抛 TypeError，
    // 且这段代码在模板字符串里 tsc 检查不到）。
    let defaultW = (() => {
      const frame = frameEl()
      if (frame === null) return 0
      const tracks = parseTracks(frame.style.gridTemplateColumns)
      if (tracks === null) return 0
      const firstW = /^\\d+px$/.test(tracks.first) ? parseInt(tracks.first, 10) : 0
      const lastW = /^\\d+px$/.test(tracks.last) ? parseInt(tracks.last, 10) : 0
      return Math.round(innerWidth - firstW - lastW)
    })()
    // 内层对话流宽度：上游 ConversationRoot 用固定 748px 的
    // --dsh-chat-content-width 把消息列/输入卡钉死居中，仅拉宽外层网格列
    // 文字宽度不会变。跟随中列宽度按 90% 同步覆盖该变量（zh_pro 旧实现同款
    // 思路），列多宽输出就有多宽；中列回到弹性默认(0)时移除覆盖交还上游默认。
    // --dsh-chat-content-width 定义在 [data-conversation-scroll]（scrollBody）
    // 的父元素（ConversationRoot root）上，下游消息列/输入卡都继承它。
    const CHAT_CONTENT_FACTOR = 0.9
    const chatRootEl = () => {
      if (document.body === null || typeof document.body.querySelector !== 'function') return null
      const scroll = document.body.querySelector('[data-conversation-scroll]')
      return scroll === null || scroll.parentElement === null ? null : scroll.parentElement
    }
    const applyContentWidth = () => {
      const root = chatRootEl()
      if (root === null || typeof root.style === 'undefined') return
      if (centerW > 0) {
        root.style.setProperty('--dsh-chat-content-width', Math.round(centerW * CHAT_CONTENT_FACTOR) + 'px', 'important')
      } else {
        root.style.removeProperty('--dsh-chat-content-width')
      }
    }
    const applyCenterW = (w) => {
      centerW = w
      const frame = frameEl()
      if (frame !== null) {
        const tracks = parseTracks(frame.style.gridTemplateColumns)
        if (tracks !== null) {
          const middle = centerW > 0 ? centerW + 'px' : 'minmax(0px, 1fr)'
          // When the center outgrows its natural elastic width it grows INTO
          // the details track; yield the details width so the three-track grid
          // never overflows the window (the details panel re-appears when the
          // center narrows back or the SPA rebuilds the frame).
          let last = tracks.last
          if (centerW > 0 && /^\\d+px$/.test(tracks.last)) {
            const firstW = /^\\d+px$/.test(tracks.first) ? parseInt(tracks.first, 10) : 56
            const lastW = parseInt(tracks.last, 10)
            const naturalW = Math.round(innerWidth - firstW - lastW)
            if (centerW > naturalW) last = Math.max(0, lastW - (centerW - naturalW)) + 'px'
          }
          frame.style.gridTemplateColumns = tracks.first + ' ' + middle + ' ' + last
        }
      }
      applyContentWidth()
      try { localStorage.setItem(CENTER_W_KEY, String(centerW)) } catch {}
    }
    const onOutWheel = (e) => {
      if (!e.ctrlKey) return
      const t = e.target
      if (t === null || t === undefined || typeof t.closest !== 'function') return
      // Only react over the center output column (not sidebar/terminal/files).
      if (t.closest('[class*="pI_x6G_centerCol"]') === null) return
      e.preventDefault()
      // 当前宽度以已保存的 centerW 为准：上游在滚轮/交互事件里会同步重渲染并
      // 抹掉我们写入的网格中列 px 值（实测事件后网格被还原为弹性宽度），网格
      // 不能当累积基准，否则每次都从弹性宽度重算、只能在一个值上下震荡。
      // centerW=0（未设定）时以渲染列宽起步。
      let cur = centerW
      if (cur <= 0) {
        const col = centerColEl()
        cur = col !== null ? Math.round(col.getBoundingClientRect().width) : innerWidth
        // 中列处于弹性态时的渲染宽度 = 当前布局的默认宽度。每次从这里起步
        // 都顺手刷新下限，布局变化（详情面板开/关、窗口缩放）后下限保持正确。
        if (defaultW !== cur) defaultW = cur
      }
      if (cur <= 0) return
      const step = e.deltaY < 0 ? 40 : -40
      // Widest the center may reach: fill the window beside the sidebar.
      // NOT innerWidth-300 — that clamp is narrower than the natural elastic
      // width whenever the details panel is closed, so the first wheel-up
      // shrank the column below its natural width and then stuck (cannot
      // widen or narrow). Growing past the natural width yields the details
      // track instead (see applyCenterW), so the output column can actually
      // get wider instead of capping below it.
      let firstW = 56
      const frame = frameEl()
      const tracks = frame !== null ? parseTracks(frame.style.gridTemplateColumns) : null
      if (tracks !== null && /^\\d+px$/.test(tracks.first)) firstW = parseInt(tracks.first, 10)
      // 下限 = 未调整前的默认宽度（用户要求 ctrl+滚轮不得把宽度压到默认值
      // 以下）：加宽可超出默认（吃掉右侧详情轨），缩小最多回到默认宽度。
      // 到达默认后把 centerW 归零、交还弹性布局 —— 网格回到 minmax(0,1fr)，
      // 内容宽度交还上游默认（748px），状态与"没改前"完全一致，而不是停在
      // 一个固定 px（那样内容会停在 0.9×默认，回不到原始样子）。
      const floorW = defaultW > 0 ? defaultW : 420
      const maxW = Math.max(floorW, Math.round(innerWidth - firstW))
      let next = Math.min(maxW, Math.max(floorW, cur + step))
      if (step < 0 && next <= floorW) next = 0
      // Wheel-up must never shrink the column.
      if (step > 0 && next < cur) next = Math.min(maxW, cur + step)
      if (next !== cur) applyCenterW(next)
    }
    // Apply a persisted width on load (and re-apply when the SPA rebuilds
    // the frame and drops our inline grid-template-columns).
    const applyOnce = () => {
      // 持久宽度若低于默认值（旧版本允许缩到默认以下），按 0 处理交还弹性
      // 默认，让"不低于默认值"的约束在加载时也生效。
      if (centerW > 0 && defaultW > 0 && centerW < defaultW) {
        centerW = 0
        try { localStorage.setItem(CENTER_W_KEY, '0') } catch {}
      }
      if (centerW > 0 && frameEl() !== null) {
        const tracks = parseTracks(frameEl().style.gridTemplateColumns)
        if (tracks !== null && tracks.middle !== centerW + 'px') applyCenterW(centerW)
      }
      applyContentWidth()
    }
    applyOnce()
    if (window.__dshOutWheelHandler === undefined) {
      window.__dshOutWheelHandler = onOutWheel
      document.addEventListener('wheel', onOutWheel, { passive: false })
    }
    // Keep a saved width alive across SPA re-renders that rebuild the frame
    // (project switch, session rebuild): re-apply whenever it drops back to
    // the elastic default while a non-zero width is saved.
    let cwTries = 0
    const cwReapply = () => {
      if (centerW > 0 && frameEl() !== null) {
        const tracks = parseTracks(frameEl().style.gridTemplateColumns)
        if (tracks !== null && tracks.middle !== centerW + 'px') applyCenterW(centerW)
      }
      // 即使网格轨道未变，ConversationRoot 也可能被 SPA 重建丢了内联变量，
      // 每次轮询都顺手重同步一次内容宽度。
      applyContentWidth()
      if (++cwTries < 120) setTimeout(cwReapply, 1000)
    }
    cwReapply()
  })()`
}

/**
 * Streaming guard: flips `html[data-dsh-streaming]` while the agent is
 * actively answering. The ambient stylesheet uses the attribute to suspend
 * the sidebar hover-preview card's backdrop-filter during streaming, so the
 * card stops re-blurring the continuously-repainting conversation behind it
 * (which the compositor rendered as a flicker right of the sidebar).
 *
 * Detection rides a MutationObserver on the body: a text change or an added
 * HTML node marks the page busy and re-arms an ~1s quiet timer; when
 * mutations stop (streaming ended), the attribute is dropped and the frosted
 * card returns. Cosmetic churn is filtered out so it can never keep the flag
 * set: the brand gradient cycle repaints the sidebar SVG (childList on SVG
 * nodes) every few seconds, and attribute/style-only changes (animations, our
 * own attribute writes) never reach the observer. Real streaming updates the
 * conversation text on nearly every token, which always lands as characterData
 * or an added HTML node, so it is never missed. A page reload or re-injection
 * resets the observer.
 */
export function streamingGuardScript(): string {
  return `(() => {
    const prev = window.__dshStreamingGuard
    if (prev) {
      prev.disconnect()
      window.__dshStreamingGuard = undefined
    }
    const root = document.documentElement
    const SVG_NS = 'http://www.w3.org/2000/svg'
    let quietTimer = null
    const setStreaming = (on) => {
      if (on) {
        if (!root.hasAttribute('data-dsh-streaming')) root.setAttribute('data-dsh-streaming', '1')
      } else if (root.hasAttribute('data-dsh-streaming')) {
        root.removeAttribute('data-dsh-streaming')
      }
    }
    const markBusy = () => {
      setStreaming(true)
      if (quietTimer !== null) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => { quietTimer = null; setStreaming(false) }, 1000)
    }
    const isSvg = (n) => n.nodeType === 1 && n.namespaceURI === SVG_NS
    const isSvgText = (n) => {
      const p = n.parentElement
      return p !== null && (isSvg(p) || (p.closest !== undefined && p.closest('svg') !== null))
    }
    // Hover-preview artifacts: the sidebar column (its rows gain a status
    // indicator when hovered) and the hover-preview card itself
    // (body > [class*="_card_"] and anything nested inside it). Neither
    // reflects streaming, so their churn must not arm the streaming flag —
    // otherwise the card's backdrop-filter stays stripped for ~1s after
    // popping in (the "no glass at first, glass appears a moment later" bug).
    const inHoverArtifact = (n) => {
      let el = n.nodeType === 1 ? n : n.parentElement
      while (el !== null && el !== document.body) {
        if (typeof el.className !== 'string') { el = el.parentElement; continue }
        if (el.className.indexOf('sidebarCol') !== -1) return true
        if (el.parentElement === document.body && el.className.indexOf('_card_') !== -1) return true
        el = el.parentElement
      }
      return false
    }
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') {
          if (isSvgText(m.target)) continue
          if (inHoverArtifact(m.target)) continue
          markBusy(); return
        }
        if (m.type === 'childList' && m.addedNodes !== null && m.addedNodes.length > 0) {
          // Ignore pure-SVG churn (the brand gradient cycle), the sidebar's
          // hover-state churn, the hover-preview card's own insertion, and
          // ported-in nodes that are not page content; only real HTML
          // additions count.
          let htmlAdded = false
          for (let i = 0; i < m.addedNodes.length; i += 1) {
            const n = m.addedNodes[i]
            if (isSvg(n)) continue
            if (inHoverArtifact(n)) continue
            if (n.nodeType === 3 && (!n.textContent || n.textContent.trim() === '')) continue
            htmlAdded = true
            break
          }
          if (htmlAdded) { markBusy(); return }
        }
      }
    })
    window.__dshStreamingGuard = obs
    obs.observe(document.body, { childList: true, characterData: true, subtree: true })
  })()`
}

