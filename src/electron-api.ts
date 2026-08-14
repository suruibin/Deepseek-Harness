/**
 * Electron API re-exports.
 *
 * Direct ESM import from 'electron' works in Electron 43+ when
 * ELECTRON_RUN_AS_NODE is not set in the environment.
 */
export { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
