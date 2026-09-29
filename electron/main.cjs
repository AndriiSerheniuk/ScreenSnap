'use strict';
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, clipboard, ipcMain, dialog, shell, session, nativeTheme } = require('electron');

const devices = require('./devices.cjs');
const capture = require('./capture.cjs');
const settings = require('./settings.cjs');

// Pinned before anything reads app.getPath('userData'), so settings live in the
// same folder whether the app is run from source or from the packaged bundle.
app.setName('ScreenSnap');

const DEV_SERVER = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
// `npm run dev` sets DSR_DEV so the window attaches to Vite; every other launch
// (including `npm start`) loads the built files from dist/.
const isDev = !app.isPackaged && process.env.DSR_DEV === '1';

/** Last device list handed to the renderer, so IPC calls can pass an id instead of an object. */
let deviceCache = new Map();
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 470,
    minWidth: 360,
    minHeight: 320,
    maxWidth: 640,
    title: 'ScreenSnap',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f2f2f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) mainWindow.loadURL(DEV_SERVER);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  settings.ensureOutputDir();
  // A packaged build gets its icon from the bundle; in development the Dock
  // would otherwise show the stock Electron icon.
  if (isDev) {
    const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
    if (require('node:fs').existsSync(iconPath)) app.dock?.setIcon(iconPath);
  }
  // Vite's dev server needs inline scripts and a websocket, so the lockdown is
  // only applied to the packaged app, which loads everything from disk.
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"],
        },
      });
    });
  }
  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f2f2f5');
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Never leave screenrecord/scrcpy/ffmpeg running on a device after the app goes away.
let quitting = false;
app.on('before-quit', async (event) => {
  if (quitting || capture.activeRecordings().length === 0) return;
  event.preventDefault();
  quitting = true;
  await capture.stopAll();
  app.quit();
});

/* ------------------------------------------------------------------- helpers */

/** Wrap a handler so the renderer always receives `{ ok, ... }` instead of a raised error. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, ...(await fn(...args)) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

function requireDevice(deviceId) {
  const device = deviceCache.get(deviceId);
  if (!device) throw new Error('That device is no longer connected — refresh the list');
  return device;
}

/* ---------------------------------------------------------------------- IPC */

handle('devices:list', async () => {
  const list = await devices.listDevices();
  deviceCache = new Map(list.map((d) => [d.id, d]));
  const recording = new Set(capture.activeRecordings().map((r) => r.deviceId));
  return {
    devices: list.map((d) => ({ ...d, recording: recording.has(d.id) })),
    active: capture.activeRecordings(),
  };
});

handle('devices:tools', async () => ({ tools: devices.toolStatus() }));

// app.getVersion() reads the packaged bundle's version, and package.json's when
// running from source, so the number always matches the build in front of you.
handle('app:version', async () => ({ version: app.getVersion() }));

/** The renderer shortens paths to `~/...`, so it needs to know the home directory. */
const withHome = (values) => ({ ...values, home: os.homedir() });

handle('settings:get', async () => ({ settings: withHome(settings.read()) }));

handle('settings:update', async (patch) => ({ settings: withHome(settings.write(patch)) }));

handle('settings:chooseDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where captures are saved',
    defaultPath: settings.read().outputDir,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Save here',
  });
  if (result.canceled || !result.filePaths[0]) return { settings: withHome(settings.read()), canceled: true };
  return { settings: withHome(settings.write({ outputDir: result.filePaths[0] })) };
});

handle('capture:start', async (deviceId) => {
  const device = requireDevice(deviceId);
  settings.ensureOutputDir();
  return await capture.startRecording(device, settings.read());
});

handle('capture:stop', async (deviceId) => {
  const result = await capture.stopRecording(deviceId);
  if (settings.read().revealAfterCapture) shell.showItemInFolder(result.outPath);
  return result;
});

handle('capture:screenshot', async (deviceId) => {
  const device = requireDevice(deviceId);
  settings.ensureOutputDir();
  const outPath = await capture.takeScreenshot(device, settings.read());
  if (settings.read().revealAfterCapture) shell.showItemInFolder(outPath);
  return { outPath };
});

handle('capture:active', async () => ({ active: capture.activeRecordings() }));

const TITLEBAR_HEIGHT = 38;

handle('window:fit', async (contentHeight) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return {};
  const wanted = Math.min(Math.max(Math.round(contentHeight) + TITLEBAR_HEIGHT, 320), 900);
  const [width, height] = mainWindow.getContentSize();
  if (Math.abs(height - wanted) > 2) mainWindow.setContentSize(width, wanted, false);
  return {};
});

handle('clipboard:write', async (text) => {
  clipboard.writeText(String(text));
  return {};
});

handle('shell:reveal', async (filePath) => {
  shell.showItemInFolder(filePath);
  return {};
});

handle('shell:open', async (filePath) => {
  const error = await shell.openPath(filePath);
  if (error) throw new Error(error);
  return {};
});
