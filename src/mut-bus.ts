/**
 * dsh-desktop shared mutation-bus snippet: a single page-level
 * MutationObserver dispatching rAF-debounced subscriber callbacks.
 *
 * The injected UI scripts (glass, misc, wallpaper, terminal) each used to run
 * their own body-wide MutationObserver. During streaming responses the SPA
 * mutates the DOM every frame, so all of those observers woke per frame and
 * each ran its own rAF + DOM queries. The bus collapses them into ONE
 * observer + ONE rAF per frame; subscribers are plain callbacks invoked in
 * order with per-subscriber try/catch isolation.
 *
 * Kept as separate (non-bus) observers on purpose:
 *   - attribute-scoped observers (body class/style/data-ds-dark-theme) —
 *     cheap, narrow filters the bus intentionally does not watch
 *   - glass.ts streamingGuard — needs the raw MutationRecords to filter
 *     characterData/addedNodes churn
 *   - glass.ts dtStyle brand repair — must run synchronously within the
 *     mutation callback (cannot wait even one rAF)
 *   - session-manage menu injection — consumes records incrementally
 *
 * The bus lives on window.__dshMutBus so every injected script (each is a
 * self-contained IIFE string) reuses the same instance; the first caller
 * creates it. Subscribers get an unsubscribe function back.
 */
export function mutBusSnippet(): string {
  return `;(function () {
    if (typeof window.__dshMutBus === 'object' && window.__dshMutBus !== null) return
    var subs = []
    var scheduled = false
    var flush = function () {
      scheduled = false
      for (var i = 0; i < subs.length; i += 1) { try { subs[i]() } catch (e) {} }
    }
    var obs = null
    try {
      obs = new MutationObserver(function () {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(flush)
      })
      // documentElement (not body): covers head churn and survives a body
      // swap; characterData so locale switches / text churn also notify.
      obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    } catch (e) { obs = null }
    window.__dshMutBus = {
      subscribe: function (fn) {
        if (obs === null) {
          // Bus unavailable (observer could not attach): degrade to a private
          // observer so the subscriber keeps its original behavior.
          var pending = false
          try {
            var o = new MutationObserver(function () {
              if (pending) return
              pending = true
              requestAnimationFrame(function () { pending = false; try { fn() } catch (e) {} })
            })
            o.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
          } catch (e) {}
          return function () {}
        }
        subs.push(fn)
        return function () {
          var ix = subs.indexOf(fn)
          if (ix !== -1) subs.splice(ix, 1)
        }
      },
    }
  })()`
}
