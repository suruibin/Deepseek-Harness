/**
 * Sandboxed preload bridge for the hosted DSH page: exposes the glass controls
 * the injected settings slider needs. Compiled to CommonJS (`.cts` →
 * `lib/preload.cjs`) because a sandboxed renderer can only load a CJS preload;
 * the main-world injected script talks to the main process through this bridge
 * instead of raw IPC.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  /** Ask the main process to change the window glass tint (0..1). */
  setAlpha: (alpha: number): void => { ipcRenderer.send('dsh:set-alpha', alpha) },
  /** Read the current persisted glass tint. */
  getAlpha: (): Promise<number> => ipcRenderer.invoke('dsh:get-alpha'),
})
