/**
 * dsh-desktop embedded-terminal injected renderer script.
 *
 * terminalScript() returns a JS string executed in the hosted page via
 * inject() in main.ts: it mounts the underlay + dock and drives xterm.js.
 * Self-contained: no imports, no shared module state.
 */
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
      '[class*="_centerCol"] header { height: 52px !important; padding: 2px 0 0 !important; }',
      '[class*="_centerCol"] header [class*="_titleRow"] { position: relative !important; height: 24px !important; min-height: 24px !important; padding: 0 !important; }',
      '[class*="_centerCol"] header [class*="_titleCluster"] { position: absolute !important; left: 50% !important; transform: translateX(-50%) !important; width: auto !important; flex: none !important; }',
      '[class*="_centerCol"] header [class*="_headerUtilities"] { margin-left: auto !important; }',
      '[class*="_centerCol"] header [class*="_tabs"] { height: 20px !important; }',
      '[class*="_centerCol"] header [class*="_tab"] { padding-bottom: 5px !important; }',
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
            // Settings trigger: fixed 126px row at its original left spot;
            // the Session log icon sits just right of it. The trigger label
            // ("设置") is now SHOWN — the SPA ships it display:none and the
            // earlier icon-only design hid it (user: 将左下角设置按钮的名字
            // 设置显示出来). gap 4px + span padding/text-align reset pull the
            // label right against the gear icon — the SPA ships the label
            // span with text-align:center + 8px padding + ~82px width, which
            // centered the text ~37px right of the icon (user: 还是离得很远
            // 你看下啥情况). Reset makes the 2 chars sit 4px after the gear
            // (user: 间距设置4px; verified: svg 26..42, text 46..74, gap 4).
            '[class*="_footArea"] [class*="_settingsArea"] { display: flex !important; align-items: center !important; box-sizing: border-box !important; }',
            '[class*="_footArea"] [class*="_settingsArea"] [class*="_trigger"] { width: 126px !important; min-width: 0 !important; padding: 6px 8px !important; margin-right: 0 !important; justify-content: flex-start !important; gap: 4px !important; }',
            '[class*="_footArea"] [class*="_settingsArea"] [class*="_trigger"] span { display: inline !important; padding: 0 !important; text-align: left !important; width: auto !important; }',
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
    let sessPending = false
    const sessSchedule = () => {
      if (sessPending) return
      sessPending = true
      requestAnimationFrame(() => { sessPending = false; moveSessionLog(); watchSessLog() })
    }
    const sessObs = new MutationObserver(sessSchedule)
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
    let rebuildPending = false
    const rebuildTick = () => {
      rebuildPending = false
      const side = document.querySelector('[class*="_sidebarCol"]')
      if (side !== null && side !== watchedSidebar) watchSidebarSize(side)
    }
    const scheduleRebuild = () => {
      if (rebuildPending) return
      rebuildPending = true
      requestAnimationFrame(rebuildTick)
    }
    const sidebarRebuildObs = new MutationObserver(scheduleRebuild)
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
      'backdrop-filter:var(--dsh-glass-main-filter)',
      '-webkit-backdrop-filter:var(--dsh-glass-main-filter)',
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
      'backdrop-filter:var(--dsh-glass-main-filter)',
      '-webkit-backdrop-filter:var(--dsh-glass-main-filter)',
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
