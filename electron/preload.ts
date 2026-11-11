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
  // PNG sequence export: pick a folder, then write one frame file at a
  // time into it. Returns null when the user cancels the dialog.
  pickSequenceFolder: () => ipcRenderer.invoke('manakin:pick-sequence-folder'),
  writeSequenceFile: (dir: string, name: string, dataUrl: string) =>
    ipcRenderer.invoke('manakin:write-sequence-file', dir, name, dataUrl),
});
