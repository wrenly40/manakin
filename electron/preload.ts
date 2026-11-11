// Preload bridge: the only privileged surface the renderer sees.
// The renderer runs with context isolation on and no Node access.
// Only the frameless window's controls live here: the app itself
// (drawing, behaviours, saving) is entirely renderer-side.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('manakin', {
  platform: process.platform,
  quit: () => ipcRenderer.invoke('manakin:quit'),
  minimise: () => ipcRenderer.invoke('manakin:minimise'),
  maximise: () => ipcRenderer.invoke('manakin:maximise'),
  fullscreen: () => ipcRenderer.invoke('manakin:fullscreen'),
  windowState: () => ipcRenderer.invoke('manakin:window-state'),
});
