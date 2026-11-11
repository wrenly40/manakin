import { app, BrowserWindow, session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// Dev is only when the Vite dev server is running: electron/dev.js sets
// NODE_ENV=development when it spawns Electron. Running the built app from
// source (`npm start`) must load dist/index.html — app.isPackaged is false
// for both, so it cannot tell them apart.
const isDev = process.env.NODE_ENV === 'development';

function createWindow(): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const win = new BrowserWindow({
    height: 860,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    title: 'Manakin',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
    width: 1280,
  });
  if (isDev) {
    void win.loadURL('http://localhost:5173');
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

void app.whenReady().then(() => {
  // Save renderer downloads (PNG / Video export) straight to Downloads, no dialog.
  session.defaultSession.on('will-download', (_event, item) => {
    const dir = app.getPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    item.setSavePath(path.join(dir, item.getFilename()));
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
