'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Extra locations to look in for CLI tools. A packaged .app is launched by
 * Finder with a bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew and
 * the Android SDK have to be found explicitly.
 */
const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  path.join(os.homedir(), 'Library/Android/sdk/platform-tools'),
  path.join(os.homedir(), 'Android/sdk/platform-tools'),
  '/usr/bin',
  '/bin',
];

function buildPath() {
  const current = (process.env.PATH || '').split(':').filter(Boolean);
  const merged = [...current];
  for (const p of EXTRA_PATHS) if (!merged.includes(p)) merged.push(p);
  return merged.join(':');
}

const ENV = { ...process.env, PATH: buildPath() };

const binCache = new Map();

/** Absolute path of a CLI tool, or null when it is not installed. */
function findBinary(name) {
  if (binCache.has(name)) return binCache.get(name);
  let found = null;
  for (const dir of buildPath().split(':')) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      found = candidate;
      break;
    } catch {
      /* keep looking */
    }
  }
  // Only a hit is remembered: a miss is what the UI tells the user to go and
  // fix ("brew install scrcpy"), and caching it would ignore them until restart.
  if (found) binCache.set(name, found);
  return found;
}

/** Spawn a process and collect stdout/stderr as text. Never rejects on a non-zero exit. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: ENV, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err.message), failed: true }));
    child.on('close', (code) => resolve({ code, stdout, stderr, failed: code !== 0 }));
    if (opts.timeout) {
      setTimeout(() => child.kill('SIGKILL'), opts.timeout).unref?.();
    }
  });
}

/** Same as run(), but stdout is returned as a Buffer (for binary payloads like PNG bytes). */
function runBinary(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: ENV, ...opts });
    const chunks = [];
    let stderr = '';
    child.stdout?.on('data', (d) => chunks.push(d));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(err.message), failed: true }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr, failed: code !== 0 }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Filesystem-safe version of an arbitrary device name. */
function slug(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60) || 'device';
}

/** Local timestamp such as 2026-09-04_14-31-07 — sorts chronologically in Finder. */
function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

/** Build an unused path in `dir`, appending -1, -2, ... if the name is taken. */
function uniquePath(dir, base, ext) {
  fs.mkdirSync(dir, { recursive: true });
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 1;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base}-${i++}${ext}`);
  return candidate;
}

module.exports = { ENV, run, runBinary, findBinary, sleep, slug, timestamp, uniquePath };
