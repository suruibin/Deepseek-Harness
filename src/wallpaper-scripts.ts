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
    // the top looked deeper (user: 顶部的颜色更深). The flat tone mirrors the
    // warm blue-gray tint the user chose as the default (用户: 默认壁纸 #6a6f7a).
    window.__dshBuiltinWallpaper = 'linear-gradient(0deg, #6a6f7a 0%, #6a6f7a 100%)'
    // Solid-color background (lowercase #rrggbb) chosen in the settings panel;
    // null means "use the built-in tone". Precedence: image url > color > builtin.
    window.__dshWallpaperColor = null
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
      const color = window.__dshWallpaperColor
      el.style.backgroundImage = url
        ? 'url("' + url + '")'
        : (color ? 'linear-gradient(0deg, ' + color + ' 0%, ' + color + ' 100%)' : window.__dshBuiltinWallpaper)
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
      window.__dshWallpaperColor = (r !== null && typeof r === 'object' && typeof r.color === 'string') ? r.color : null
      ensure()
      // The sidebar glass floor keys off the wallpaper presence; notify any
      // listener (glassControlsScript) so the CSS variables re-apply.
      window.dispatchEvent(new CustomEvent('dsh-wallpaper-changed'))
    }).catch(() => {})
  })()`
}

/**
 * Injected UI for the background wallpaper in the hosted settings page,
 * mounted inside the injected Theme Settings panel (主题设置). The panel owns
 * the slot order, so the auto-rotate row is mounted into a DEDICATED slot
 * ([data-dsh-theme-rotate-slot]) placed directly ABOVE the background-opacity
 * slider, while the rest of the wallpaper block (folder/pick/clear, solid
 * colors, thumbnail grid) mounts into [data-dsh-theme-wallpaper-slot]. Both
 * elements are built by the same mount() closure, so they share all state and
 * the rotate logic can read the grid's folder pool and vice versa.
 *
 * The "choose" button opens the system file dialog in the main process via
 * the preload bridge; "remove" clears the wallpaper.
 */
export function wallpaperControlScript(): string {
  return `(() => {
    if (window.__dshWallpaperControlObserver) {
      window.__dshWallpaperControlObserver.disconnect()
      window.__dshWallpaperControlObserver = undefined
    }
    const mount = () => {
      if (window.dshDesktop === undefined) return
      // The wallpaper controls live in the injected Theme Settings panel
      // (主题设置), mounted by themeSettingsScript.
      const panel = document.querySelector('[data-dsh-theme-panel]')
      if (panel === null) return
      const rotateSlot = panel.querySelector('[data-dsh-theme-rotate-slot]')
      const wallpaperSlot = panel.querySelector('[data-dsh-theme-wallpaper-slot]')
      if (rotateSlot === null || wallpaperSlot === null) return
      const zh = window.__dshThemeLocale !== 'en'
      const title = zh ? '背景壁纸' : 'Wallpaper'
      // Keep one instance of each mounted block; a locale switch only re-syncs
      // the wallpaper title. If React re-renders the panel, both slots are
      // fresh and both blocks are rebuilt together.
      const existingRotate = document.querySelector('[data-dsh-rotate]')
      const existingWp = document.querySelector('[data-dsh-wallpaper]')
      if (existingRotate !== null && existingWp !== null) {
        const titleEl = existingWp.firstElementChild
        if (titleEl !== null && titleEl.textContent !== title) titleEl.textContent = title
        return
      }
      if (existingRotate !== null) existingRotate.remove()
      if (existingWp !== null) existingWp.remove()
        const folderLabel = zh ? '选择文件夹…' : 'Choose folder…'
        const pickLabel = zh ? '选择壁纸…' : 'Choose wallpaper…'
        const clearLabel = zh ? '移除' : 'Remove'
        const colorLabel = zh ? '纯色背景' : 'Solid color'
        const rotateLabel = zh ? '自动更换壁纸' : 'Auto-rotate wallpaper'
        const intervalLabel = zh ? '间隔' : 'Interval'
        const minuteLabel = zh ? '分钟' : 'min'
        const customColorLabel = zh ? '自定义' : 'Custom'
        // Preset solid-color backgrounds; the first one matches the built-in
        // default tone (#6a6f7a). Two rows of 8: warm neutrals, blues/purples,
        // teals/greens, warm accents, pastels, and dark darks.
        const PRESET_COLORS = [
          '#6a6f7a', '#9aa1af', '#5b8def', '#7c5cf0', '#2fb8a0', '#3f6f8f', '#d98e4a', '#c96a6a',
          '#f5a8b8', '#e8a34a', '#7d8a4f', '#4aa3a8', '#9c6bb0', '#5f7bb5', '#b56a8c', '#4c5668',
        ]
        // ── Auto-rotate row (mounted ABOVE the background-opacity slider) ──
        const rotateEl = document.createElement('div')
        rotateEl.dataset.dshRotate = 'true'
        rotateEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:16px 0'
        rotateEl.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
            '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px">' +
              '<input type="checkbox" data-dsh-rotate-enable style="width:14px;height:14px;accent-color:#4176e6;cursor:pointer">' + rotateLabel +
            '</label>' +
            '<span style="color:var(--dsw-alias-label-tertiary);font-size:12px">' + intervalLabel + '</span>' +
            '<input type="number" data-dsh-rotate-minutes min="1" max="1440" step="1" value="30" style="width:64px;background:rgba(39,46,62,0.6);color:var(--dsw-alias-label-primary);border:1px solid rgba(128,132,142,0.3);border-radius:8px;padding:4px 8px;font-size:12px;outline:none">' +
            '<span style="color:var(--dsw-alias-label-tertiary);font-size:12px">' + minuteLabel + '</span>' +
          '</div>'
        // ── Wallpaper block (folder/pick/clear + colors + thumbnail grid) ──
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
          '<div data-dsh-color-row style="display:none;align-items:center;gap:10px;flex-wrap:wrap">' +
            '<span style="color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap">' + colorLabel + '</span>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px">' +
              PRESET_COLORS.map((c) => '<button data-dsh-color="' + c + '" title="' + c + '" style="width:24px;height:24px;border-radius:50%;background:' + c + ';border:2px solid rgba(255,255,255,0.25);cursor:pointer;padding:0;box-sizing:border-box"></button>').join('') +
            '</div>' +
            '<span style="color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap">' + customColorLabel + '</span>' +
            '<input type="color" data-dsh-color-custom value="#6a6f7a" title="' + customColorLabel + '" style="width:34px;height:26px;border:none;padding:0;background:transparent;cursor:pointer;border-radius:6px">' +
          '</div>' +
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
        const colorRow = control.querySelector('[data-dsh-color-row]')
        const colorBtns = control.querySelectorAll('[data-dsh-color]')
        const customColorInput = control.querySelector('[data-dsh-color-custom]')
        const rotateCb = rotateEl.querySelector('[data-dsh-rotate-enable]')
        const rotateMin = rotateEl.querySelector('[data-dsh-rotate-minutes]')
        if (folderBtn === null || pickBtn === null || clearBtn === null || nameEl === null || grid === null) return
        if (colorRow !== null) colorRow.style.display = 'flex'
        // Auto-rotate state lives on the window (the blocks re-mount on every
        // panel open); pool/index/timer survive so re-opening keeps rotating.
        if (window.__dshRotatePool === undefined) window.__dshRotatePool = []
        if (window.__dshRotateIndex === undefined) window.__dshRotateIndex = -1
        const updateColorActive = (hex) => {
          colorBtns.forEach((b) => {
            const on = b.getAttribute('data-dsh-color') === hex
            b.style.borderColor = on ? '#4176e6' : 'rgba(255,255,255,0.25)'
            b.style.boxShadow = on ? '0 0 0 2px rgba(65,118,230,0.35)' : 'none'
          })
          if (customColorInput !== null && typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex)) {
            customColorInput.value = hex
          }
        }
        const apply = (url, file, srcPath) => {
          window.__dshWallpaperUrl = url
          nameEl.textContent = file === null ? '' : file
          const layer = document.getElementById('dsh-dt-wallpaper')
          const color = window.__dshWallpaperColor
          if (layer !== null) {
            layer.style.backgroundImage = url ? 'url("' + url + '")' : (color ? 'linear-gradient(0deg, ' + color + ' 0%, ' + color + ' 100%)' : (window.__dshBuiltinWallpaper || 'none'))
          }
          updateColorActive(color)
          // Sidebar glass floor follows wallpaper presence; re-apply variables.
          window.dispatchEvent(new CustomEvent('dsh-wallpaper-changed'))
          if (typeof srcPath === 'string' && srcPath !== '') {
            try { localStorage.setItem('dsh-desktop-wallpaper-src', srcPath) } catch {}
            grid.querySelectorAll('.dsh-wp-cell').forEach((cell) => {
              cell.classList.toggle('dsh-wp-active', cell.dataset.path === srcPath)
            })
          }
        }
        // An image wallpaper clears any solid color first (image takes
        // precedence); the persisted color is dropped so 移除 returns to the
        // built-in tone instead of the previously chosen color.
        const applyImage = (url, file, srcPath) => {
          window.__dshWallpaperColor = null
          window.dshDesktop.wallpaper.setColor(null)
          apply(url, file, srcPath)
        }
        // ── Auto-rotate ──
        const stopRotate = () => {
          if (window.__dshRotateTimer !== undefined) { clearInterval(window.__dshRotateTimer); window.__dshRotateTimer = undefined }
        }
        const persistRotate = () => {
          const minutes = Number(rotateMin.value) || 30
          const folder = (() => { try { return localStorage.getItem('dsh-desktop-wallpaper-folder') } catch { return null } })()
          window.dshDesktop.wallpaper.setRotate({ enabled: rotateCb.checked, minutes, folder: folder || null })
        }
        const ensurePool = () => {
          const pool = window.__dshRotatePool || []
          if (pool.length > 0) return Promise.resolve(pool)
          const folder = (() => { try { return localStorage.getItem('dsh-desktop-wallpaper-folder') } catch { return null } })()
          if (folder === null || folder === '') return Promise.resolve([])
          return window.dshDesktop.fs.list(folder).then((res) => {
            if (res !== null && typeof res === 'object' && !res.error && Array.isArray(res.entries)) {
              const paths = res.entries.filter((e) => e && typeof e.name === 'string' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(e.name)).map((e) => e.path)
              window.__dshRotatePool = paths
              return paths
            }
            return []
          }).catch(() => [])
        }
        const rotateTick = () => {
          const pool = window.__dshRotatePool || []
          if (pool.length === 0) return
          window.__dshRotateIndex = ((window.__dshRotateIndex || 0) + 1) % pool.length
          const path = pool[window.__dshRotateIndex]
          window.dshDesktop.wallpaper.apply(path).then((res) => {
            if (res !== null && typeof res === 'object' && typeof res.url === 'string') {
              applyImage(res.url, typeof res.file === 'string' ? res.file : null, path)
            }
          }).catch(() => {})
        }
        const startRotate = () => {
          stopRotate()
          const minutes = Number(rotateMin.value) || 30
          window.__dshRotateTimer = setInterval(rotateTick, Math.max(1, minutes) * 60000)
          rotateTick()
        }
        // Restart the running timer with the current interval WITHOUT applying
        // the next wallpaper (used when only the minutes value changes).
        const restartRotate = () => {
          if (!rotateCb.checked) return
          stopRotate()
          const minutes = Number(rotateMin.value) || 30
          window.__dshRotateTimer = setInterval(rotateTick, Math.max(1, minutes) * 60000)
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
          window.__dshRotatePool = Array.isArray(entries) ? entries.map((e) => e.path) : []
          if (!Array.isArray(entries) || entries.length === 0) {
            grid.style.display = 'none'
            return
          }
          grid.style.display = 'grid'
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
                  applyImage(res.url, typeof res.file === 'string' ? res.file : null, e.path)
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
        // The blocks are recreated on every panel open and have no dispose
        // hook, so keep at most ONE resize listener via a window registry.
        const prevResize = window.__dshWpResizeHandlers || []
        prevResize.forEach((h) => window.removeEventListener('resize', h))
        window.__dshWpResizeHandlers = [onWinResize]
        window.addEventListener('resize', onWinResize)
        // Solid-color pick: clear any image wallpaper first (image takes
        // precedence in the layer), then persist + apply the chosen color.
        // Shared by the preset swatches and the custom color picker.
        const applyColor = (color) => {
          window.dshDesktop.wallpaper.clear().then(() => {
            return window.dshDesktop.wallpaper.setColor(color)
          }).then((res) => {
            if (res !== null && typeof res === 'object' && res.ok) {
              window.__dshWallpaperColor = color
              apply(null, null, null)
            }
          }).catch(() => {})
        }
        colorBtns.forEach((b) => {
          b.addEventListener('click', () => {
            const color = b.getAttribute('data-dsh-color')
            if (color !== null) applyColor(color)
          })
        })
        if (customColorInput !== null) {
          customColorInput.addEventListener('input', () => {
            applyColor(customColorInput.value)
          })
        }
        rotateCb.addEventListener('change', () => {
          persistRotate()
          if (rotateCb.checked) startRotate()
          else stopRotate()
        })
        // Persist each keystroke; only restart the running timer on commit.
        rotateMin.addEventListener('input', () => { persistRotate() })
        rotateMin.addEventListener('change', restartRotate)
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
            // With rotate enabled, (re)start so a freshly picked folder's pool
            // is picked up immediately instead of waiting for the next tick.
            if (rotateCb.checked) startRotate()
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
            if (res !== null && typeof res === 'object' && res.ok) {
              // 移除 resets EVERYTHING back to the built-in tone: clear the
              // image AND any solid color (a color kept the layer tinted after
              // remove, which read as "移除无效").
              window.__dshWallpaperColor = null
              window.dshDesktop.wallpaper.setColor(null)
              apply(null, null, null)
            }
          }).catch(() => {})
        })
        // Shared grid restore: list a folder and render its thumbnails. Kept
        // here so both the persisted-folder path (get(), fresh launch) and the
        // localStorage path (same-session re-open) use identical logic. The
        // delay lets the panel switch animation settle before the grid starts
        // decoding thumbnails (the queue otherwise competes with the
        // transition and reads as a hitch).
        const restoreGridFromFolder = (folder) => {
          if (folder === null || folder === '') return
          setTimeout(() => {
            window.dshDesktop.fs.list(folder).then((res) => {
              if (res === null || typeof res !== 'object' || res.error || !Array.isArray(res.entries)) return
              const imgs = res.entries.filter((e) => e && typeof e.name === 'string' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(e.name)).map((e) => ({ name: e.name, path: e.path }))
              nameEl.textContent = typeof res.path === 'string' ? res.path : ''
              renderGrid(imgs)
            }).catch(() => {})
          }, 350)
        }
        window.dshDesktop.wallpaper.get().then((res) => {
          if (res !== null && typeof res === 'object') {
            const url = typeof res.url === 'string' ? res.url : null
            apply(url, typeof res.file === 'string' ? res.file : null, null)
            // Restore the auto-rotate controls from persisted state; resume
            // the timer so rotation continues across panel re-opens.
            const r = (typeof res.rotate === 'object' && res.rotate !== null) ? res.rotate : null
            if (r !== null) {
              rotateCb.checked = r.enabled === true
              const mins = Number(r.minutes)
              if (Number.isFinite(mins) && mins >= 1) rotateMin.value = String(mins)
              // Resume the interval without advancing the wallpaper now —
              // reopening the panel must not change the background.
              if (rotateCb.checked) restartRotate()
            }
            // The folder is persisted in glass-settings.json, which survives
            // the per-launch random port (unlike localStorage). Mirror it back
            // into localStorage for the same-session code; on a fresh launch
            // where localStorage is empty, restore the grid from it so the
            // rotate pool is populated without re-picking the folder.
            const folder = typeof res.folder === 'string' && res.folder !== '' ? res.folder : null
            if (folder !== null) {
              const prev = (() => { try { return localStorage.getItem('dsh-desktop-wallpaper-folder') } catch { return null } })()
              try { localStorage.setItem('dsh-desktop-wallpaper-folder', folder) } catch {}
              if (prev === null) restoreGridFromFolder(folder)
            }
          }
        }).catch(() => {})
        // Same-session re-open: localStorage already holds the folder, restore
        // the grid without reopening the dialog.
        const lastFolder = (() => { try { return localStorage.getItem('dsh-desktop-wallpaper-folder') } catch { return null } })()
        if (lastFolder !== null && lastFolder !== '') restoreGridFromFolder(lastFolder)
      // Mount each block into its dedicated slot inside the Theme Settings
      // panel (rotate above the opacity slider, wallpaper below it).
      rotateSlot.appendChild(rotateEl)
      wallpaperSlot.appendChild(control)
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
