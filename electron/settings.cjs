'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  /** Where every screenshot and recording is written. */
  outputDir: path.join(os.homedir(), 'Desktop', 'ScreenSnap'),
  /** Container recordings are written in: 'mov' or 'mp4'. */
  videoFormat: 'mov',
  /** screenrecord bitrate for Android, in Mbps. */
  androidBitrateMbps: 8,
  /** Encoder bitrate for physical iPhones/iPads, in Mbps. */
  iosBitrateMbps: 10,
  /** Reveal each finished capture in Finder. */
  revealAfterCapture: false,
  /** Turn on Android's "Show taps" while recording, so touches appear in the video. */
  showTouches: false,
  /** Include simulators that are not booted in the device list. */
  showOfflineDevices: false,
};

let cache = null;

function read() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function write(patch) {
  cache = { ...read(), ...patch };
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2));
  return cache;
}

/** Create the output directory if it is missing; fall back to the default if that fails. */
function ensureOutputDir() {
  const settings = read();
  try {
    fs.mkdirSync(settings.outputDir, { recursive: true });
    return settings.outputDir;
  } catch {
    fs.mkdirSync(DEFAULTS.outputDir, { recursive: true });
    return write({ outputDir: DEFAULTS.outputDir }).outputDir;
  }
}

module.exports = { read, write, ensureOutputDir, DEFAULTS };
