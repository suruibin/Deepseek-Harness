/**
 * dsh-desktop user plugins: files under <appPath>/plugins (built-in, ship with
 * the package) and <userData>/plugins (user-owned) that get injected into the
 * hosted page, so styling/scripting customizations never require rebuilding
 * the shell.
 *
 * - *.css — appended to a <style> node that is injected after the built-in
 *   glass CSS, so user rules can override the built-in styling.
 * - *.js  — executed in the page context, in filename order, after the CSS.
 *
 * A user file whose basename matches a built-in one replaces it (built-ins
 * win nothing — the user copy is the only one loaded). Everything else is
 * appended in filename order, so users can both override and extend.
 *
 * All reads are defensive: a missing/unreadable plugin directory or file is
 * skipped, never fatal — the shell must boot cleanly without any plugins.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PluginFile {
  /** Basename, e.g. "settings-icon.css". */
  name: string
  /** File contents, decoded as UTF-8. */
  content: string
}

/**
 * Read every *.css / *.js file from a directory, in filename order.
 * A missing or unreadable directory yields an empty list.
 */
export function readPluginDir(dir: string): PluginFile[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const files: PluginFile[] = []
  for (const name of entries.sort()) {
    if (!name.endsWith('.css') && !name.endsWith('.js')) continue
    try {
      files.push({ name, content: readFileSync(join(dir, name), 'utf8') })
    } catch {
      // Unreadable file (permissions, vanished mid-scan): skip it.
    }
  }
  return files
}

/**
 * Merge built-in and user plugins: a user file with the same basename
 * replaces the built-in one; everything else is appended in order. The
 * result is the complete, ordered plugin list to inject.
 */
export function mergePlugins(builtin: PluginFile[], user: PluginFile[]): PluginFile[] {
  const merged = [...builtin]
  for (const u of user) {
    const idx = merged.findIndex((b) => b.name === u.name)
    if (idx >= 0) merged[idx] = u
    else merged.push(u)
  }
  return merged
}

/**
 * JavaScript that mounts the plugin CSS as a <style> node in the page head.
 * One node for all plugin CSS so repeated injections (every did-finish-load)
 * replace instead of stack; the SPA can still re-apply its own rules over it,
 * exactly like the built-in glass style.
 */
export function pluginsCssScript(css: string[]): string {
  const text = css.join('\n')
  return `(() => {
    const prev = document.querySelector('#dsh-dt-plugin-style')
    if (prev !== null) prev.remove()
    const style = document.createElement('style')
    style.id = 'dsh-dt-plugin-style'
    style.textContent = ${JSON.stringify(text)}
    document.head.appendChild(style)
  })()`
}
