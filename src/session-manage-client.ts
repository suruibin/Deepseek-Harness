/**
 * 会话删除 + 已归档管理（页面注入脚本，主进程半边在 session-manage.ts）。
 *
 * 能力：
 *   1. 会话行三点菜单注入「删除会话」项（中文界面「删除会话」/ 英文
 *      Delete session，锚点随官方「归档会话」/ Archive session 项）。
 *      点击 → 确认框 → ①官方网关 workspace.archiveSession（即时隐藏行）
 *      ②window.dshDesktop.session.delete（移日志入回收站 + 账本移除）。
 *   2. 侧栏底部注入「查看已归档」按钮 → 覆盖面板按工作区分组列出已归档
 *      会话（标题/工作区/时间，行操作：取消归档 / 删除），各工作区底部
 *      附自己的「回收站」区（恢复 / 永久删除 / 清空）。行直接点击即可多选，
 *      再批量删除 / 恢复。
 *
 * 说明：
 *   - 宿主内存 registry 权威且不随 workspace.json 文件改动刷新，因此
 *     「取消归档 / 恢复」的账本改动需重启 dsh 后才在官方列表生效（toast 提示）。
 *   - 全部逻辑包在大 try/catch 里：IIFE 内任何未捕获异常都会中断后续注入，
 *     故每个独立步骤（菜单、面板、异步）都各自兜底。
 *   - 样式复用页面可见的 --dsw-* CSS 变量（深色/浅色主题自动适配）。
 */
export function sessionManageScript(): string {
  return `(() => {
  try {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
    if (typeof document.body === 'undefined' || document.body === null) return
    if (window.__dshSessionManage) { window.__dshSessionManage.dispose(); window.__dshSessionManage = undefined }
    if (typeof window.dshDesktop === 'undefined' || !window.dshDesktop.session) return

    const SESSION_MENU_MARKS = ['归档会话', 'Archive session']
    const INJECTED_MARK = 'data-dsh-sm-delete-session'

    // ---------- 提示条 ----------
    let toastTimer = null
    let toastEl = null
    let toastStyleEl = null
    const ensureToastStyle = function () {
      if (toastStyleEl !== null && document.head.contains(toastStyleEl)) return
      toastStyleEl = document.createElement('style')
      toastStyleEl.setAttribute('data-dsh-sm', 'toast')
      toastStyleEl.textContent = [
        '.dsh-sm-toast{position:fixed;top:120px;left:50%;z-index:1400;pointer-events:none;',
        'display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100vw - 48px));',
        'padding:12px 16px;border-radius:14px;',
        'background:var(--dsw-alias-button-contrast-fill);',
        'color:var(--dsw-alias-label-primary-inverted);font-size:14px;line-height:22px;',
        'box-shadow:var(--dsw-shadow-lv3);transform:translateX(-50%);',
        'animation:dsh-sm-toast-in 160ms ease-out,dsh-sm-toast-fade 1000ms ease 3000ms forwards}',
        '@keyframes dsh-sm-toast-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}',
        '@keyframes dsh-sm-toast-fade{to{opacity:0}}',
      ].join('')
      document.head.appendChild(toastStyleEl)
    }
    const showToast = function (text, duration) {
      try {
        if (document.body === null) return
        if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null }
        if (toastEl !== null && toastEl.parentNode !== null) toastEl.parentNode.removeChild(toastEl)
        ensureToastStyle()
        toastEl = document.createElement('div')
        toastEl.className = 'dsh-sm-toast'
        toastEl.setAttribute('role', 'status')
        toastEl.textContent = text
        document.body.appendChild(toastEl)
        toastTimer = setTimeout(function () {
          toastTimer = null
          if (toastEl !== null && toastEl.parentNode !== null) toastEl.parentNode.removeChild(toastEl)
          toastEl = null
        }, typeof duration === 'number' ? duration : 3500)
      } catch {
        // 提示条失败不影响主流程
      }
    }

    // ---------- 确认框 ----------
    let confirmEl = null
    const removeConfirm = function () {
      if (confirmEl !== null && confirmEl.parentNode !== null) confirmEl.parentNode.removeChild(confirmEl)
      confirmEl = null
    }
    const showConfirm = function (title, desc, okLabel, onOk) {
      removeConfirm()
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;inset:0;z-index:1500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.18)'
      const card = document.createElement('div')
      card.style.cssText = 'width:min(440px,calc(100vw - 48px));border-radius:16px;padding:20px;background:rgba(39,46,62,0.28);backdrop-filter:blur(var(--dsh-glass-popup-blur,40px)) saturate(140%);-webkit-backdrop-filter:blur(var(--dsh-glass-popup-blur,40px)) saturate(140%);color:var(--dsh-alias-label-primary-inverted,#f2f3f5);box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,0.35));border:1px solid rgba(255,255,255,0.12)'
      const titleEl = document.createElement('div')
      titleEl.textContent = title
      titleEl.style.cssText = 'font-size:16px;line-height:24px;font-weight:600;margin-bottom:10px'
      const descEl = document.createElement('div')
      descEl.textContent = desc
      descEl.style.cssText = 'font-size:13px;line-height:20px;color:rgba(255,255,255,0.65);margin-bottom:18px;word-break:break-word'
      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.textContent = '取消'
      cancel.style.cssText = 'padding:6px 16px;border-radius:10px;border:1px solid rgba(127,127,127,0.35);background:transparent;cursor:pointer;font:inherit;font-size:14px;color:inherit'
      const ok = document.createElement('button')
      ok.type = 'button'
      ok.textContent = okLabel || '确定'
      ok.style.cssText = 'padding:6px 16px;border-radius:10px;border:none;background:#d93026;color:#fff;cursor:pointer;font:inherit;font-size:14px'
      cancel.addEventListener('click', removeConfirm, false)
      ok.addEventListener('click', function () {
        removeConfirm()
        onOk()
      }, false)
      actions.appendChild(cancel)
      actions.appendChild(ok)
      card.appendChild(titleEl)
      card.appendChild(descEl)
      card.appendChild(actions)
      overlay.appendChild(card)
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) removeConfirm()
      }, false)
      document.body.appendChild(overlay)
      confirmEl = overlay
    }

    // ---------- 会话行解析 ----------
    const readSessionIdFromRow = function (row) {
      try {
        const fiberKeys = Object.keys(row).filter(function (key) { return key.indexOf('__reactFiber$') === 0 })
        for (let k = 0; k < fiberKeys.length; k += 1) {
          let fiber = row[fiberKeys[k]]
          let depth = 0
          while (fiber !== null && fiber !== undefined && depth < 40) {
            const memoizedProps = fiber.memoizedProps
            if (memoizedProps !== null && memoizedProps !== undefined && typeof memoizedProps === 'object') {
              const node = memoizedProps.node
              if (node !== null && typeof node === 'object' && typeof node.id === 'string') return node.id
            }
            fiber = fiber.return
            depth += 1
          }
        }
      } catch { /* 忽略 */ }
      try {
        const propsKeys = Object.keys(row).filter(function (key) { return key.indexOf('__reactProps$') === 0 })
        for (let k = 0; k < propsKeys.length; k += 1) {
          const props = row[propsKeys[k]]
          if (props !== null && typeof props === 'object') {
            const node = props.node
            if (node !== null && typeof node === 'object' && typeof node.id === 'string') return node.id
          }
        }
      } catch { /* 忽略 */ }
      return null
    }
    const sessionRowOf = function (el) {
      let node = el
      while (node !== null && node !== document.body) {
        if (node.nodeType === 1 && node.getAttribute !== undefined && node.getAttribute('role') === 'treeitem') return node
        node = node.parentElement
      }
      return null
    }
    const titleOf = function (row) {
      try {
        const titleSpan = row.querySelector('span[class*="title"]')
        if (titleSpan !== null && titleSpan.textContent !== '') return titleSpan.textContent.trim()
      } catch { /* 忽略 */ }
      return row.textContent !== null ? row.textContent.trim().slice(0, 80) : ''
    }
    const titleOfId = function (id) {
      return String(id).replace(/^session-/, '').slice(0, 8)
    }

    // ---------- 官方网关 / 桌面桥 ----------
    const rpcArchive = function (sessionId) {
      const rpcId = 'dsh-sm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      return fetch('/api/workspace.archiveSession', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: rpcId, method: 'workspace.archiveSession', payload: { sessionId: sessionId } }),
      }).then(function (response) {
        return response.json().catch(function () { return null })
      }).then(function (parsed) {
        if (parsed === null || typeof parsed !== 'object') return false
        const result = parsed.result
        if (result !== null && result !== undefined && typeof result === 'object' && result.ok === true) return true
        if (parsed.ok === true) return true
        return false
      }).catch(function () { return false })
    }
    const bridge = function () {
      return (typeof window.dshDesktop !== 'undefined' && window.dshDesktop !== null && window.dshDesktop.session) ? window.dshDesktop.session : null
    }
    const performDelete = function (sessionId) {
      showToast('正在删除会话…', 2500)
      return Promise.resolve()
        .then(function () { return rpcArchive(sessionId) })
        .then(function () {
          const s = bridge()
          if (s === null) return { ok: false, message: '桌面桥接不可用' }
          return s.delete(sessionId)
        })
        .then(function (res) {
          if (res !== null && res !== undefined && typeof res === 'object' && res.ok === true) {
            showToast('会话已删除（日志已移入回收站）', 4000)
            return true
          }
          const message = res !== null && typeof res === 'object' && typeof res.message === 'string' ? res.message : '未知错误'
          showToast('删除失败：' + message, 5000)
          return false
        })
        .catch(function (err) {
          showToast('删除失败：' + (err instanceof Error ? err.message : String(err)), 5000)
          return false
        })
    }
    const runUnarchive = function (sessionId) {
      showToast('正在取消归档…', 2000)
      const s = bridge()
      const p = s === null ? Promise.resolve({ ok: false, message: '桌面桥接不可用' }) : s.unarchive(sessionId)
      return p.then(function (res) {
        if (res !== null && typeof res === 'object' && res.ok === true) {
          showToast('已取消归档（官方侧栏需点「重启 dsh」后更新）', 5000)
          return true
        }
        showToast('取消归档失败：' + (res !== null && typeof res === 'object' && typeof res.message === 'string' ? res.message : '未知错误'), 5000)
        return false
      }).catch(function (err) {
        showToast('取消归档失败：' + (err instanceof Error ? err.message : String(err)), 5000)
        return false
      })
    }
    const runTrashRestore = function (sessionId) {
      showToast('正在恢复…', 2000)
      const s = bridge()
      const p = s === null ? Promise.resolve({ ok: false, message: '桌面桥接不可用' }) : s.trashRestore(sessionId)
      return p.then(function (res) {
        if (res !== null && typeof res === 'object' && res.ok === true) {
          showToast('已恢复（官方侧栏需点「重启 dsh」后更新）', 5000)
          return true
        }
        showToast('恢复失败：' + (res !== null && typeof res === 'object' && typeof res.message === 'string' ? res.message : '未知错误'), 5000)
        return false
      }).catch(function (err) {
        showToast('恢复失败：' + (err instanceof Error ? err.message : String(err)), 5000)
        return false
      })
    }

    // ---------- 菜单注入 ----------
    const closeOfficialMenu = function () {
      try {
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      } catch { /* 忽略 */ }
    }
    let lastEllipsisRow = null
    const onDocumentPointerDown = function (event) {
      try {
        const target = event.target
        if (target === null || target.nodeType !== 1 || typeof target.closest !== 'function') return
        const button = target.closest('button')
        if (button === null) return
        const label = button.getAttribute('aria-label')
        if (label === null) return
        if ((label.indexOf('会话') !== -1 && label.indexOf('的操作') !== -1) || label.indexOf('Session actions') !== -1) {
          lastEllipsisRow = sessionRowOf(button)
        }
      } catch { /* 忽略 */ }
    }
    document.addEventListener('pointerdown', onDocumentPointerDown, true)

    const injectIntoMenu = function (menu) {
      try {
        if (menu.getAttribute(INJECTED_MARK) !== null) return
        // 清理孤儿注入项：菜单关闭/重开后残留的按钮（无 click handler）。
        const orphans = document.querySelectorAll('button[' + INJECTED_MARK + ']')
        for (let i = 0; i < orphans.length; i += 1) {
          const orphan = orphans[i]
          if (orphan !== null && orphan.parentNode !== null && !menu.contains(orphan)) orphan.parentNode.removeChild(orphan)
        }
        let anchor = null
        const items = menu.querySelectorAll('[role="menuitem"]')
        for (let i = 0; i < items.length; i += 1) {
          const label = items[i].textContent !== null ? items[i].textContent.trim() : ''
          for (let m = 0; m < SESSION_MENU_MARKS.length; m += 1) {
            if (label === SESSION_MENU_MARKS[m]) { anchor = items[i]; break }
          }
          if (anchor !== null) break
        }
        if (anchor === null) return
        const row = lastEllipsisRow
        if (row === null) return
        const sessionId = readSessionIdFromRow(row)
        if (sessionId === null) return
        const title = titleOf(row)
        const wrap = anchor.parentElement
        if (wrap === null) return
        const clone = wrap.cloneNode(true)
        const button = clone.querySelector('[role="menuitem"]')
        if (button === null) return
        button.setAttribute(INJECTED_MARK, '')
        const en = (anchor.textContent !== null ? anchor.textContent.trim() : '') === 'Archive session'
        const icon = button.querySelector('span:first-child')
        if (icon !== null) { icon.textContent = '🗑'; icon.style.fontSize = '14px' }
        const label = button.querySelector('span:last-child')
        const deleteLabel = en ? 'Delete session' : '删除会话'
        if (label !== null) {
          label.textContent = deleteLabel
          label.title = '删除会话（日志移入回收站，可稍后恢复）'
        } else {
          button.textContent = deleteLabel
        }
        button.style.color = ''
        button.addEventListener('click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          closeOfficialMenu()
          showConfirm(
            '删除会话',
            '将把该会话的日志移入回收站，并从工作区列表移除（可稍后在「查看已归档 → 对应工作区 → 回收站」恢复）。若该会话正在运行，建议先停止再删除。确定继续吗？',
            '删除',
            function () { performDelete(sessionId) },
          )
        }, false)
        if (wrap.nextSibling !== null) wrap.parentNode.insertBefore(clone, wrap.nextSibling)
        else wrap.parentNode.appendChild(clone)
        menu.setAttribute(INJECTED_MARK, '')
        void title
      } catch { /* 注入失败不影响其它菜单 */ }
    }

    // ---------- 已归档面板 ----------
    const formatTime = function (ts) {
      if (!ts) return ''
      try {
        const d = new Date(ts)
        if (Number.isNaN(d.getTime())) return ''
        const pad = function (n) { return String(n).padStart(2, '0') }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      } catch { return '' }
    }
    const smallBtn = function (label, onClick, danger) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.style.cssText = 'padding:4px 12px;border-radius:8px;border:none;cursor:pointer;font:inherit;font-size:12px;flex-shrink:0;' + (danger ? 'background:#d93026;color:#fff' : 'background:rgba(255,255,255,0.14);color:inherit')
      b.addEventListener('click', function (event) { event.stopPropagation(); onClick() }, false)
      return b
    }
    const itemMetaText = function (item) {
      const parts = []
      if (typeof item.workspaceTitle === 'string' && item.workspaceTitle !== '') parts.push(item.workspaceTitle)
      if (typeof item.cwd === 'string' && item.cwd !== '') parts.push(item.cwd)
      const time = item.createdAt !== null && item.createdAt !== undefined ? formatTime(item.createdAt) : ''
      if (time !== '') parts.push(time)
      return parts.join(' · ')
    }
    const refreshPanel = function () {
      const body = document.getElementById('dsh-sm-panel-body')
      if (body !== null) renderPanelBody(body)
    }
    const askConfirm = function (title, desc, okLabel, onOk) {
      showConfirm(title, desc, okLabel, onOk)
    }

    // ---------- 多选 / 批量操作 ----------
    const toggleSelect = function (id) {
      if (panelState.selectedIds[id] === true) delete panelState.selectedIds[id]
      else panelState.selectedIds[id] = true
      updateSelectionUI()
    }
    // 行级直接多选：勾选框 + 行点击即切换选中（无需显式多选模式）。
    const attachRowSelection = function (row, id) {
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = panelState.selectedIds[id] === true
      cb.setAttribute('data-dsh-sm-cb', '')
      cb.style.cssText = 'flex-shrink:0;width:15px;height:15px;accent-color:#4c9fff;cursor:pointer'
      cb.addEventListener('change', function (event) {
        if (event.stopPropagation !== undefined) event.stopPropagation()
        toggleSelect(id)
      }, false)
      row.insertBefore(cb, row.firstChild)
      row.style.cursor = 'pointer'
      row.addEventListener('click', function (event) {
        if (event.target !== null && event.target.nodeType === 1 && event.target.type === 'checkbox') return
        toggleSelect(id)
      }, false)
    }
    const selectAllCurrent = function () {
      const ids = (ui.currentRows || []).concat(ui.currentTrashRows || []).map(function (r) { return r.sessionId })
      const allSelected = ids.length > 0 && ids.every(function (id) { return panelState.selectedIds[id] === true })
      if (allSelected) panelState.selectedIds = {}
      else {
        panelState.selectedIds = {}
        for (let i = 0; i < ids.length; i += 1) panelState.selectedIds[ids[i]] = true
      }
      updateSelectionUI()
    }
    const updateSelectionUI = function () {
      const body = document.getElementById('dsh-sm-panel-body')
      if (body !== null) {
        const rows = body.querySelectorAll('[data-dsh-sm-id]')
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]
          const id = row.getAttribute('data-dsh-sm-id')
          const sel = id !== null && panelState.selectedIds[id] === true
          const cb = row.querySelector('input[data-dsh-sm-cb]')
          if (cb !== null) cb.checked = sel
          row.style.boxShadow = sel ? 'inset 0 0 0 1px rgba(255,255,255,0.55)' : ''
        }
      }
      updateActBar()
    }
    const updateActBar = function () {
      if (ui.selectAllBtn !== null) {
        const ids = (ui.currentRows || []).concat(ui.currentTrashRows || []).map(function (r) { return r.sessionId })
        const allSelected = ids.length > 0 && ids.every(function (id) { return panelState.selectedIds[id] === true })
        ui.selectAllBtn.textContent = allSelected ? '取消全选' : '全选'
      }
      const bar = document.getElementById('dsh-sm-ms-act-bar')
      if (bar === null) return
      bar.textContent = ''
      const trashIds = {}
      for (let i = 0; i < (ui.currentTrashRows || []).length; i += 1) trashIds[ui.currentTrashRows[i].sessionId] = true
      const selArchived = []
      const selTrash = []
      for (const id of Object.keys(panelState.selectedIds)) {
        if (panelState.selectedIds[id] !== true) continue
        if (trashIds[id] === true) selTrash.push(id)
        else selArchived.push(id)
      }
      if (selArchived.length > 0) {
        bar.appendChild(smallBtn('取消归档选中（' + selArchived.length + '）', function () { batchArchivedUnarchive(selArchived) }, false))
        bar.appendChild(smallBtn('删除选中（' + selArchived.length + '）', function () { batchArchivedDelete(selArchived) }, true))
      }
      if (selTrash.length > 0) {
        bar.appendChild(smallBtn('恢复选中（' + selTrash.length + '）', function () { batchTrashRestore(selTrash) }, false))
        bar.appendChild(smallBtn('永久删除选中（' + selTrash.length + '）', function () { batchTrashDelete(selTrash) }, true))
      }
    }
    const clearSelectExit = function () {
      panelState.selectedIds = {}
    }
    const performDeleteNoToast = function (sessionId) {
      return Promise.resolve()
        .then(function () { return rpcArchive(sessionId) })
        .then(function () {
          const s = bridge()
          if (s === null) return false
          return s.delete(sessionId).then(function (res) {
            return res !== null && res !== undefined && typeof res === 'object' && res.ok === true
          })
        })
        .catch(function () { return false })
    }
    const runTrashRestoreNoToast = function (sessionId) {
      const s = bridge()
      if (s === null) return Promise.resolve(false)
      return s.trashRestore(sessionId).then(function (res) {
        return res !== null && typeof res === 'object' && res.ok === true
      }).catch(function () { return false })
    }
    const runUnarchiveNoToast = function (sessionId) {
      const s = bridge()
      if (s === null) return Promise.resolve(false)
      return s.unarchive(sessionId).then(function (res) {
        return res !== null && typeof res === 'object' && res.ok === true
      }).catch(function () { return false })
    }
    const runTrashDeleteNoToast = function (sessionId) {
      const s = bridge()
      if (s === null) return Promise.resolve(false)
      return s.trashDelete(sessionId).then(function (res) {
        return res !== null && typeof res === 'object' && res.ok === true
      }).catch(function () { return false })
    }
    const runSeq = function (ids, fn, done) {
      return ids.reduce(function (p, id) {
        return p.then(function () {
          return fn(id).then(function (ok) { if (ok) done.n += 1 })
        })
      }, Promise.resolve())
    }
    const batchArchivedDelete = function (ids) {
      askConfirm('删除选中会话', '将把选中的 ' + ids.length + ' 个会话日志移入回收站并从列表移除。确定继续吗？', '删除', function () {
        const done = { n: 0 }
        runSeq(ids, performDeleteNoToast, done).then(function () {
          clearSelectExit()
          showToast('已删除 ' + done.n + ' 个会话（日志已移入回收站）', 4000)
          refreshPanel()
        })
      })
    }
    const batchArchivedUnarchive = function (ids) {
      askConfirm('取消归档选中会话', '将把选中的 ' + ids.length + ' 个会话重新挂回工作区列表。官方侧栏需点「重启 dsh」后更新。确定继续吗？', '取消归档', function () {
        const done = { n: 0 }
        runSeq(ids, runUnarchiveNoToast, done).then(function () {
          clearSelectExit()
          showToast('已取消归档 ' + done.n + ' 个会话（官方侧栏点「重启 dsh」后更新）', 5000)
          refreshPanel()
        })
      })
    }
    const batchTrashRestore = function (ids) {
      askConfirm('恢复选中会话', '将把选中的 ' + ids.length + ' 个会话日志移回并重新挂回列表。官方侧栏需点「重启 dsh」后更新。确定继续吗？', '恢复', function () {
        const done = { n: 0 }
        runSeq(ids, runTrashRestoreNoToast, done).then(function () {
          clearSelectExit()
          showToast('已恢复 ' + done.n + ' 个会话', 4000)
          refreshPanel()
        })
      })
    }
    const batchTrashDelete = function (ids) {
      askConfirm('删除选中会话', '将永久删除回收站中选中的 ' + ids.length + ' 个会话日志，不可恢复。确定继续吗？', '永久删除', function () {
        const done = { n: 0 }
        runSeq(ids, runTrashDeleteNoToast, done).then(function () {
          clearSelectExit()
          showToast('已永久删除 ' + done.n + ' 个会话', 4000)
          refreshPanel()
        })
      })
    }
    // 清空当前工作区自己的回收站（仅删该工作区已删除的会话）。
    const emptyWorkspaceTrash = function (items) {
      askConfirm('清空回收站', '将永久删除当前工作区回收站中 ' + items.length + ' 个会话的日志，不可恢复。确定继续吗？', '清空', function () {
        showToast('正在清空回收站…', 2500)
        const done = { n: 0 }
        runSeq(items.map(function (i) { return i.sessionId }), runTrashDeleteNoToast, done).then(function () {
          clearSelectExit()
          showToast('已清空回收站 ' + done.n + ' 个会话', 4000)
          refreshPanel()
        })
      })
    }

    const archivedRow = function (item) {
      const row = document.createElement('div')
      row.setAttribute('data-dsh-sm-id', item.sessionId)
      const selected = panelState.selectedIds[item.sessionId] === true
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,0.07);margin-bottom:6px;' + (selected ? 'box-shadow:inset 0 0 0 1px rgba(255,255,255,0.55)' : '')
      const info = document.createElement('div')
      info.style.cssText = 'flex:1;min-width:0'
      const name = document.createElement('div')
      name.textContent = (item.title !== '' ? item.title : titleOfId(item.sessionId))
      name.style.cssText = 'font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      const meta = document.createElement('div')
      meta.textContent = itemMetaText(item)
      meta.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      info.appendChild(name)
      info.appendChild(meta)
      attachRowSelection(row, item.sessionId)
      row.appendChild(info)
      if (item.trashed === true) {
        const badge = document.createElement('span')
        badge.textContent = '已删除'
        badge.style.cssText = 'font-size:11px;color:#fff;background:#d93026;border-radius:6px;padding:2px 6px;flex-shrink:0'
        row.appendChild(badge)
        row.appendChild(smallBtn('恢复', function () {
          askConfirm('恢复会话', '将把该会话日志移回原目录并重新挂回工作区列表。官方侧栏需在面板右上角点「重启 dsh」后更新。确定继续吗？', '恢复', function () {
            runTrashRestore(item.sessionId).then(function () { refreshPanel() })
          })
        }, false))
      } else {
        row.appendChild(smallBtn('取消归档', function () {
          askConfirm('取消归档会话', '将把该会话重新挂回工作区列表。官方侧栏需在面板右上角点「重启 dsh」后更新。确定继续吗？', '取消归档', function () {
            runUnarchive(item.sessionId).then(function () { refreshPanel() })
          })
        }, false))
        row.appendChild(smallBtn('删除', function () {
          askConfirm('删除会话', '将把该会话的日志移入回收站，并从列表移除。若该会话正在运行，建议先停止。确定继续吗？', '删除', function () {
            performDelete(item.sessionId).then(function () { refreshPanel() })
          })
        }, true))
      }
      return row
    }
    const trashRow = function (item) {
      const row = document.createElement('div')
      row.setAttribute('data-dsh-sm-id', item.sessionId)
      const selected = panelState.selectedIds[item.sessionId] === true
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,0.07);margin-bottom:6px;' + (selected ? 'box-shadow:inset 0 0 0 1px rgba(255,255,255,0.55)' : '')
      const info = document.createElement('div')
      info.style.cssText = 'flex:1;min-width:0'
      const name = document.createElement('div')
      name.textContent = (item.title !== '' ? item.title : titleOfId(item.sessionId))
      name.style.cssText = 'font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      const meta = document.createElement('div')
      const parts = []
      if (typeof item.cwd === 'string' && item.cwd !== '') parts.push(item.cwd)
      const time = typeof item.trashedAt === 'number' ? formatTime(item.trashedAt) : ''
      if (time !== '') parts.push('删除于 ' + time)
      meta.textContent = parts.join(' · ')
      meta.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      info.appendChild(name)
      info.appendChild(meta)
      attachRowSelection(row, item.sessionId)
      row.appendChild(info)
      row.appendChild(smallBtn('恢复', function () {
        askConfirm('恢复会话', '将把该会话日志移回原目录并重新挂回工作区列表。官方侧栏需在面板右上角点「重启 dsh」后更新。确定继续吗？', '恢复', function () {
          runTrashRestore(item.sessionId).then(function () { refreshPanel() })
        })
      }, false))
      row.appendChild(smallBtn('删除', function () {
        askConfirm('永久删除会话', '将永久删除该会话在回收站中的日志，不可恢复。确定继续吗？', '永久删除', function () {
          const s = bridge()
          const p = s === null ? Promise.resolve({ ok: false, message: '桌面桥接不可用' }) : s.trashDelete(item.sessionId)
          p.then(function (res) {
            if (res !== null && typeof res === 'object' && res.ok === true) {
              showToast('已永久删除', 3000)
            } else {
              showToast('删除失败：' + (res !== null && typeof res === 'object' && typeof res.message === 'string' ? res.message : '未知错误'), 5000)
            }
            refreshPanel()
          }).catch(function (err) {
            showToast('删除失败：' + (err instanceof Error ? err.message : String(err)), 5000)
            refreshPanel()
          })
        })
      }, true))
      return row
    }
    const emptyText = function (text) {
      const el = document.createElement('div')
      el.textContent = text
      el.style.cssText = 'font-size:13px;color:rgba(255,255,255,0.55);padding:12px 0'
      return el
    }
    // 面板交互状态：当前选中的标签（'全部' / 工作区分组键）与选中集合。
    // 条目在固定高度的滚动区内直接竖直滚动浏览。
    const panelState = { activeTab: '全部', selectedIds: {} }
    // 面板 UI 引用：当前标签的数据行 / 该工作区回收站行 / 全选按钮（局部刷新用）。
    const ui = { currentRows: [], currentTrashRows: [], selectAllBtn: null }
    const groupKeyOf = function (item) {
      if (typeof item.workspaceTitle === 'string' && item.workspaceTitle !== '') return item.workspaceTitle
      if (typeof item.cwd === 'string' && item.cwd !== '') {
        const parts = item.cwd.split('/').filter(function (p) { return p !== '' })
        return parts.length > 0 ? parts[parts.length - 1] : '未分类'
      }
      return '未分类'
    }
    const groupOfItems = function (items) {
      const groupKeys = []
      const groups = {}
      for (let i = 0; i < items.length; i += 1) {
        const key = groupKeyOf(items[i])
        if (!Object.prototype.hasOwnProperty.call(groups, key)) {
          groupKeys.push(key)
          groups[key] = []
        }
        groups[key].push(items[i])
      }
      return { groupKeys: groupKeys, groups: groups }
    }
    // 横向标签（chip）导航：全部 / 各工作区（回收站并入各工作区内，不单独显示）。
    // 会话多时按标签点选过滤。
    const chipBar = function (wsKeys, countOf, active, onPick) {
      const bar = document.createElement('div')
      bar.style.cssText = 'display:flex;gap:6px;overflow-x:auto;flex-wrap:nowrap;padding-bottom:6px;margin-bottom:4px;scrollbar-width:thin'
      const make = function (key, label) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.textContent = label
        const isActive = key === active
        chip.style.cssText = 'flex-shrink:0;padding:4px 11px;border-radius:999px;border:none;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;' + (isActive ? 'background:rgba(255,255,255,0.24);color:#fff;font-weight:600' : 'background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.78)')
        chip.addEventListener('click', function () { onPick(key) }, false)
        return chip
      }
      bar.appendChild(make('全部', '全部（' + countOf('__all__') + '）'))
      for (let i = 0; i < wsKeys.length; i += 1) {
        const key = wsKeys[i]
        bar.appendChild(make(key, key + '（' + countOf(key) + '）'))
      }
      return bar
    }
    const renderPanelBody = function (body) {
      body.textContent = ''
      const s = bridge()
      if (s === null) {
        body.appendChild(emptyText('桌面桥接不可用'))
        return
      }
      const archivedP = s.archivedList().catch(function () { return null })
      const trashP = s.trashList().catch(function () { return null })
      Promise.all([archivedP, trashP]).then(function (results) {
        const archived = results[0]
        const trash = results[1]
        const archivedItems = (archived !== null && archived !== undefined && Array.isArray(archived.items)) ? archived.items : []
        const trashItems = (trash !== null && trash !== undefined && Array.isArray(trash.items)) ? trash.items : []
        const gArch = groupOfItems(archivedItems)
        const gTrash = groupOfItems(trashItems)
        // 工作区 chip：合并「已归档」与「回收站」中出现过的工作区（回收站不单独成标签）。
        const wsKeys = []
        const pushKey = function (k) { if (wsKeys.indexOf(k) === -1) wsKeys.push(k) }
        for (let i = 0; i < gArch.groupKeys.length; i += 1) pushKey(gArch.groupKeys[i])
        for (let i = 0; i < gTrash.groupKeys.length; i += 1) pushKey(gTrash.groupKeys[i])
        const countOf = function (key) {
          if (key === '__all__') return archivedItems.length
          const a = gArch.groups[key] !== undefined ? gArch.groups[key].length : 0
          const t = gTrash.groups[key] !== undefined ? gTrash.groups[key].length : 0
          return a + t
        }
        // 选中的标签已不存在（如该工作区最后一条被删）时回落到「全部」。
        const validTabs = ['全部'].concat(wsKeys)
        if (validTabs.indexOf(panelState.activeTab) === -1) panelState.activeTab = '全部'
        body.appendChild(chipBar(wsKeys, countOf, panelState.activeTab, function (key) {
          panelState.activeTab = key
          clearSelectExit()
          renderPanelBody(body)
        }))
        // 工具条：全选 / 当前工作区清空回收站 / 批量操作按钮。
        const toolbar = document.createElement('div')
        toolbar.style.cssText = 'display:flex;align-items:center;gap:8px;padding-bottom:6px;margin-bottom:4px;flex-shrink:0'
        const selectAll = document.createElement('button')
        selectAll.type = 'button'
        selectAll.textContent = '全选'
        selectAll.style.cssText = 'padding:4px 12px;border-radius:8px;border:none;cursor:pointer;font:inherit;font-size:12px;flex-shrink:0;background:rgba(255,255,255,0.08);color:inherit'
        selectAll.addEventListener('click', selectAllCurrent, false)
        ui.selectAllBtn = selectAll
        toolbar.appendChild(selectAll)
        const spacer = document.createElement('div')
        spacer.style.cssText = 'flex:1'
        toolbar.appendChild(spacer)
        // 各工作区自己的回收站：仅在当前工作区标签且该区有已删除会话时显示清空按钮。
        if (panelState.activeTab !== '全部') {
          const trashOfWs = gTrash.groups[panelState.activeTab] !== undefined ? gTrash.groups[panelState.activeTab] : []
          if (trashOfWs.length > 0) {
            toolbar.appendChild(smallBtn('清空回收站', function () { emptyWorkspaceTrash(trashOfWs) }, true))
          }
        }
        const actBar = document.createElement('div')
        actBar.id = 'dsh-sm-ms-act-bar'
        actBar.style.cssText = 'display:flex;align-items:center;gap:8px'
        toolbar.appendChild(actBar)
        body.appendChild(toolbar)
        // 当前标签对应的数据行（工作区标签下：已归档在前，回收站区在后）。
        let rows = []
        let trashRows = []
        if (panelState.activeTab === '全部') {
          rows = archivedItems
          trashRows = []
        } else {
          rows = gArch.groups[panelState.activeTab] !== undefined ? gArch.groups[panelState.activeTab] : []
          trashRows = gTrash.groups[panelState.activeTab] !== undefined ? gTrash.groups[panelState.activeTab] : []
        }
        ui.currentRows = rows
        ui.currentTrashRows = trashRows
        if (rows.length === 0 && trashRows.length === 0) {
          body.appendChild(emptyText('暂无已归档会话'))
        } else {
          for (let i = 0; i < rows.length; i += 1) body.appendChild(archivedRow(rows[i]))
          if (trashRows.length > 0) {
            const sec = document.createElement('div')
            sec.textContent = '回收站（' + trashRows.length + '）'
            sec.style.cssText = 'font-size:12px;font-weight:600;color:rgba(255,255,255,0.55);padding:10px 2px 6px'
            body.appendChild(sec)
            for (let i = 0; i < trashRows.length; i += 1) body.appendChild(trashRow(trashRows[i]))
          }
        }
        updateSelectionUI()
      }).catch(function () {
        body.appendChild(emptyText('加载失败'))
      })
    }
    const removePanel = function () {
      const overlay = document.getElementById('dsh-sm-panel-overlay')
      if (overlay !== null && overlay.parentNode !== null) overlay.parentNode.removeChild(overlay)
    }
    const openPanel = function () {
      removePanel()
      const overlay = document.createElement('div')
      overlay.id = 'dsh-sm-panel-overlay'
      overlay.style.cssText = 'position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.35)'
      const card = document.createElement('div')
      card.style.cssText = 'width:min(620px,calc(100vw - 48px));height:560px;display:flex;flex-direction:column;border-radius:16px;padding:20px;background:rgba(39,46,62,0.45);backdrop-filter:blur(var(--dsh-glass-popup-blur,40px)) saturate(140%);-webkit-backdrop-filter:blur(var(--dsh-glass-popup-blur,40px)) saturate(140%);color:var(--dsh-alias-label-primary-inverted,#f2f3f5);box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,0.35));border:1px solid rgba(255,255,255,0.12)'
      const header = document.createElement('div')
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0'
      const titleEl = document.createElement('div')
      titleEl.textContent = '已归档会话'
      titleEl.style.cssText = 'font-size:16px;line-height:24px;font-weight:600'
      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;align-items:center;gap:8px'
      const restartBtn = document.createElement('button')
      restartBtn.type = 'button'
      restartBtn.textContent = '重启 dsh'
      restartBtn.title = '重启后端 dsh web，使「取消归档 / 恢复」在官方侧栏生效'
      restartBtn.style.cssText = 'padding:4px 12px;border-radius:8px;border:none;cursor:pointer;font:inherit;font-size:12px;background:rgba(255,255,255,0.14);color:inherit'
      restartBtn.addEventListener('click', function () {
        askConfirm('重启 dsh', '将重启后端 dsh web 服务（约几秒），使「取消归档 / 恢复」在官方侧栏生效，当前窗口会自动重载。确定继续吗？', '重启', function () {
          showToast('正在重启 dsh…', 30000)
          const s = bridge()
          const p = s === null ? Promise.resolve({ ok: false, message: '桌面桥接不可用' }) : s.restartWeb()
          p.then(function (res) {
            if (res !== null && typeof res === 'object' && res.ok === true) {
              showToast('dsh 已重启，官方侧栏已更新', 4000)
            } else {
              showToast('重启失败：' + (res !== null && typeof res === 'object' && typeof res.message === 'string' ? res.message : '未知错误'), 6000)
            }
          }).catch(function (err) {
            showToast('重启失败：' + (err instanceof Error ? err.message : String(err)), 6000)
          })
        })
      }, false)
      const closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.textContent = '✕'
      closeBtn.style.cssText = 'border:none;background:transparent;cursor:pointer;font:inherit;font-size:14px;color:rgba(255,255,255,0.6);padding:4px 8px'
      closeBtn.addEventListener('click', removePanel, false)
      actions.appendChild(restartBtn)
      actions.appendChild(closeBtn)
      header.appendChild(titleEl)
      header.appendChild(actions)
      card.appendChild(header)
      const body = document.createElement('div')
      body.id = 'dsh-sm-panel-body'
      body.style.cssText = 'overflow-y:auto;flex:1;min-height:0'
      card.appendChild(body)
      overlay.appendChild(card)
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) removePanel()
      }, false)
      document.body.appendChild(overlay)
      renderPanelBody(body)
    }
    const ARCHIVE_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 5.5h12v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8Z" stroke="currentColor" stroke-width="1.2"/><path d="M2 5.5 3.2 2.8a1 1 0 0 1 .9-.6h7.8a1 1 0 0 1 .9.6L14 5.5" stroke="currentColor" stroke-width="1.2"/><path d="M6.5 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'

    // ---------- 已归档按钮：毛玻璃悬浮提示（对齐搜索按钮的 frosted bubble） ----------
    let archiveTipEl = null
    let archiveTipStyleEl = null
    const ensureArchiveTipStyle = function () {
      if (archiveTipStyleEl !== null && document.head.contains(archiveTipStyleEl)) return
      archiveTipStyleEl = document.createElement('style')
      archiveTipStyleEl.setAttribute('data-dsh-sm', 'archive-tip')
      archiveTipStyleEl.textContent = [
        '#dsh-sm-archive-btn[data-dsh-sm-collapsed="1"]{display:none !important}',
        '#dsh-sm-archive-tip{position:fixed;z-index:2200;pointer-events:none;white-space:nowrap;',
        'padding:3px 7px;border-radius:8px;font-size:13px;line-height:20px;color:#fff;',
        'background:rgba(15,17,23,0.35);',
        'backdrop-filter:blur(20px) saturate(1.4);-webkit-backdrop-filter:blur(20px) saturate(1.4);',
        'box-shadow:0 2px 8px rgba(0,0,0,0.25);}',
      ].join('')
      document.head.appendChild(archiveTipStyleEl)
    }
    const hideArchiveTip = function () {
      if (archiveTipEl !== null && archiveTipEl.parentNode !== null) archiveTipEl.parentNode.removeChild(archiveTipEl)
      archiveTipEl = null
    }
    const showArchiveTip = function (btn) {
      try {
        if (archiveTipEl !== null) hideArchiveTip()
        ensureArchiveTipStyle()
        const tip = document.createElement('span')
        tip.id = 'dsh-sm-archive-tip'
        tip.setAttribute('role', 'tooltip')
        tip.setAttribute('data-side', 'bottom')
        tip.textContent = '查看已归档'
        document.body.appendChild(tip)
        const r = btn.getBoundingClientRect()
        const tw = tip.offsetWidth
        const th = tip.offsetHeight
        let left = r.left + r.width / 2 - tw / 2
        let top = r.bottom + 6
        if (top + th > window.innerHeight - 8) top = r.top - th - 6
        if (left < 8) left = 8
        else if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8
        tip.style.left = left + 'px'
        tip.style.top = top + 'px'
        archiveTipEl = tip
      } catch { /* 提示条失败不影响主流程 */ }
    }
    const syncArchiveRail = function () {
      try {
        const btn = document.getElementById('dsh-sm-archive-btn')
        if (btn === null) return
        const collapsed = document.querySelector('[class*="hHd-Xa_collapsed"]') !== null
        btn.setAttribute('data-dsh-sm-collapsed', collapsed ? '1' : '0')
        if (collapsed) hideArchiveTip()
      } catch { /* 忽略 */ }
    }

    const ensurePanelButton = function () {
      try {
        if (document.getElementById('dsh-sm-archive-btn') !== null) { syncArchiveRail(); return }
        const btn = document.createElement('button')
        btn.id = 'dsh-sm-archive-btn'
        btn.type = 'button'
        btn.setAttribute('aria-label', '查看已归档')
        btn.innerHTML = ARCHIVE_ICON_SVG
        btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-right:4px;border:none;border-radius:6px;background:transparent;cursor:pointer;color:rgb(173,178,184);flex-shrink:0'
        btn.addEventListener('mouseenter', function () { showArchiveTip(btn) }, false)
        btn.addEventListener('mouseleave', hideArchiveTip, false)
        btn.addEventListener('click', function () { hideArchiveTip(); openPanel() }, false)
        // 优先：在工作区 section header 的「工作区」标签前插入图标入口。
        const headers = document.querySelectorAll('[class*="sectionHeader"]')
        for (let i = 0; i < headers.length; i += 1) {
          const h = headers[i]
          if (!(h instanceof HTMLElement) || h.offsetParent === null) continue
          const t = (h.textContent !== null ? h.textContent : '').trim()
          if (t.indexOf('工作区') === 0 || t.indexOf('Workspace') === 0) {
            const label = h.querySelector('[class*="sectionLabel"]')
            if (label !== null && label.parentNode !== null) label.parentNode.insertBefore(btn, label)
            else h.insertBefore(btn, h.firstChild)
            return
          }
        }
        // 兜底：侧栏底部 footArea（保持原文本按钮）。
        let foot = null
        const footCandidates = document.querySelectorAll('[class*="footArea"]')
        for (let i = 0; i < footCandidates.length; i += 1) {
          const el = footCandidates[i]
          if (el instanceof HTMLElement && el.offsetParent !== null) { foot = el; break }
        }
        if (foot !== null) {
          btn.innerHTML = '查看已归档'
          btn.style.cssText = 'display:flex;align-items:center;gap:6px;margin:6px 10px;padding:6px 10px;border:none;border-radius:8px;cursor:pointer;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#888);background:transparent'
          foot.appendChild(btn)
          return
        }
        const newSession = document.querySelector('button[aria-label="新建会话"], button[aria-label="New session"]')
        if (newSession !== null && newSession.parentNode !== null) {
          newSession.parentNode.insertBefore(btn, newSession.nextSibling)
        }
      } catch { /* 侧栏未就绪，下次再注入 */ }
    }

    // ---------- MutationObserver：菜单 + 面板按钮 ----------
    let observer = null
    const runPass = function (root) {
      try {
        const menus = root !== undefined && root !== null && typeof root.querySelectorAll === 'function'
          ? root.querySelectorAll('div[role="menu"]')
          : document.body.querySelectorAll('div[role="menu"]')
        for (let i = 0; i < menus.length; i += 1) injectIntoMenu(menus[i])
        ensurePanelButton()
      } catch { /* 忽略 */ }
    }
    observer = new MutationObserver(function (records) {
      if (!Array.isArray(records)) { runPass(document.body); return }
      for (const record of records) {
        if (record.type === 'attributes') {
          // 侧栏折叠/展开仅切换 class 属性，需同步已归档按钮的收起态。
          if (record.attributeName === 'class' || record.attributeName === 'style') syncArchiveRail()
          continue
        }
        const added = record.addedNodes
        if (added === null || added === undefined || added.length === 0) continue
        for (let i = 0; i < added.length; i += 1) {
          const raw = added[i]
          if (raw === null || raw === undefined || raw.nodeType !== 1) continue
          const node = raw
          if (node.getAttribute !== undefined && node.getAttribute('role') === 'menu') {
            injectIntoMenu(node)
            continue
          }
          if (typeof node.querySelectorAll === 'function') runPass(node)
        }
        ensurePanelButton()
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    runPass(document.body)

    // 延迟兜底：首屏后 1s / 2s 各补一次，覆盖侧栏异步渲染完成的场景。
    const lateTimers = [1000, 2000].map(function (ms) {
      return setTimeout(function () { runPass(document.body) }, ms)
    })

    window.__dshSessionManage = {
      dispose: function () {
        if (observer !== null) observer.disconnect()
        observer = null
        document.removeEventListener('pointerdown', onDocumentPointerDown, true)
        lateTimers.forEach(function (t) { clearTimeout(t) })
        removeConfirm()
        removePanel()
        hideArchiveTip()
        if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null }
        if (toastEl !== null && toastEl.parentNode !== null) toastEl.parentNode.removeChild(toastEl)
        toastEl = null
      },
    }
  } catch (err) {
    console.error('[dsh-session-manage] 注入失败:', err)
  }
})()`
}
