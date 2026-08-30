/**
 * dsh-desktop wallpaper injected renderer scripts.
 *
 * wallpaperLayerScript() mounts the translucent wallpaper layer under the
 * glass canvas; wallpaperControlScript() drives the picker/apply/clear flow
 * in the hosted page. Each returns a JS string executed via inject() in
 * main.ts. Self-contained: no imports, no shared module state.
 */
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
    // Built-in frosted backdrop when no user wallpaper is set: backdrop-filter
    // can only blur content painted inside the page (not the OS desktop behind
    // the transparent window), so without a wallpaper the popups/main glass had
    // nothing to frost and showed the raw desktop through. A FLAT pastel tone
    // (no gradient) keeps every screen position the same color, so the sidebar
    // and the top header card always read identically — a multi-stop gradient
    // made the left (sidebar) and center (header) sample different colors and
    // the top looked deeper (user: 顶部的颜色更深).
    window.__dshBuiltinWallpaper = 'linear-gradient(0deg, #9aa1af 0%, #9aa1af 100%)'
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
      el.style.backgroundImage = url ? 'url("' + url + '")' : window.__dshBuiltinWallpaper
    }
    ensure()
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => { pending = false; ensure() })
    }
    const obs = new MutationObserver(schedule)
    window.__dshWallpaperObserver = obs
    obs.observe(document.body, { childList: true, subtree: true })
    window.dshDesktop.wallpaper.get().then((res) => {
      const r = res
      window.__dshWallpaperUrl = (r !== null && typeof r === 'object' && typeof r.url === 'string') ? r.url : null
      ensure()
      // The sidebar glass floor keys off the wallpaper presence; notify any
      // listener (glassControlsScript) so the CSS variables re-apply.
      window.dispatchEvent(new CustomEvent('dsh-wallpaper-changed'))
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
          if (layer !== null) layer.style.backgroundImage = url ? 'url("' + url + '")' : (window.__dshBuiltinWallpaper || 'none')
          // Sidebar glass floor follows wallpaper presence; re-apply variables.
          window.dispatchEvent(new CustomEvent('dsh-wallpaper-changed'))
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
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => { pending = false; mount() })
    }
    const obs = new MutationObserver(schedule)
    window.__dshWallpaperControlObserver = obs
    // childList: row (re)mounts; characterData: locale switches swap text in
    // place, which must re-sync the mounted control's title.
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
  })()`
}
