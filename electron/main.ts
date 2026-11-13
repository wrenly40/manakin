import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";

// Dev is only when the Vite dev server is running: electron/dev.js sets
// NODE_ENV=development when it spawns Electron. Running the built app from
// source (`npm start`) must load dist/index.html — app.isPackaged is false
// for both, so it cannot tell them apart.
const isDev = process.env.NODE_ENV === "development";

let win: BrowserWindow | null = null;

// Frameless, like Bowerbird's main window: no native title bar, the
// renderer draws the window controls in the top bar and the top bar is
// the window's drag region.
function createWindow(): void {
  const iconPath = path.join(__dirname, "..", "assets", "icon.png");
  win = new BrowserWindow({
    height: 860,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: "#ffffff",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    title: "Manakin",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    width: 1280,
  });
  if (isDev) {
    void win.loadURL("http://localhost:5173");
  } else {
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
  win.on("closed", () => { win = null; });
}

// Frameless window controls, invoked from the renderer's top bar.
ipcMain.handle("manakin:minimise", () => { if (win) win.minimize(); });
ipcMain.handle("manakin:quit", () => { if (win) win.destroy(); app.quit(); });
ipcMain.handle("manakin:fullscreen", () => {
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});
ipcMain.handle("manakin:maximise", () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle("manakin:window-state", () => ({
  maximised: win ? win.isMaximized() : false,
  fullscreen: win ? win.isFullScreen() : false,
}));

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
