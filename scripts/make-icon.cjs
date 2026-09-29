'use strict';
/**
 * Renders assets/icon.html to build/icon.png at 1024x1024.
 * Run with: npx electron scripts/make-icon.cjs
 * `npm run icon` then turns that PNG into build/icon.icns.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, '..', 'build', 'icon.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });

  await win.loadFile(path.join(__dirname, '..', 'assets', 'icon.html'));
  await new Promise((resolve) => setTimeout(resolve, 600));

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  console.log(`wrote ${OUT} (${image.getSize().width}x${image.getSize().height})`);
  app.exit(0);
});
