const { app, BrowserWindow } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
const staticEntry = path.join(app.getAppPath(), 'out', 'index.html');

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#e9eef7',
    title: 'SmartFlow NLEX',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (isDev) {
    const devUrl = process.env.NEXT_DEV_URL || 'http://127.0.0.1:3002/dashboard';

    // In local runs without a dev server (e.g. after npm run build), fallback to static export.
    let hasLoaded = false;
    const fallbackToStatic = async () => {
      if (hasLoaded) return;
      hasLoaded = true;
      try {
        await window.loadFile(staticEntry);
      } catch (error) {
        console.error('Failed to load static fallback:', error);
      }
    };

    window.webContents.once('did-fail-load', fallbackToStatic);
    window.loadURL(devUrl).catch(fallbackToStatic);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    window.loadFile(staticEntry);
  }

  window.once('ready-to-show', () => {
    window.show();
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
