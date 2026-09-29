'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, findBinary } = require('./util.cjs');

/**
 * A device entry handed to the renderer.
 * @typedef {Object} Device
 * @property {string} id        stable key: `android:<serial>` | `simulator:<udid>` | `ios:<udid>`
 * @property {'android'|'ios'} platform
 * @property {'device'|'emulator'|'simulator'} kind
 * @property {string} name      human readable, e.g. "Pixel 7" / "iPhone 17"
 * @property {string} serial    adb serial / simulator UDID / device UDID
 * @property {string} osVersion e.g. "16" or "26.5"
 * @property {boolean} ready    false when we can see it but cannot capture it yet
 * @property {string} [note]    why it is not ready, shown in the UI
 * @property {boolean} canRecord false when the device can be screenshotted but not recorded
 * @property {'screenrecord'|'scrcpy'|null} [recordVia] which recorder this device needs
 * @property {string} [recordNote] why it cannot be recorded, shown in the UI
 * @property {string} [avIndex] AVFoundation input index (physical iOS only)
 */

/* ------------------------------------------------------------------ Android */

/**
 * Properties worth asking every Android device for, in one round trip.
 * `getprop` prints an empty line for anything the device does not define, so the
 * answers line up with this list either way.
 */
const ANDROID_PROPS = [
  'ro.product.manufacturer',
  'ro.product.model',
  'ro.build.version.release',
  // Vendors put the name people actually know ("HUAWEI P20 lite") in one of
  // these, while ro.product.model stays the sales code ("ANE-LX1").
  'ro.config.marketing_name',
  'ro.product.marketname',
  'ro.product.vendor.marketname',
  'ro.vendor.product.display',
  // An emulator's AVD name beats its model, which is always sdk_gphone64_<arch>.
  'ro.boot.qemu.avd_name',
  'ro.kernel.qemu.avd_name',
];

/** Brands that spell themselves differently from how title case would. */
const BRAND_SPELLING = {
  asus: 'ASUS', blu: 'BLU', hmd: 'HMD', htc: 'HTC', lg: 'LG', oneplus: 'OnePlus',
  oppo: 'OPPO', poco: 'POCO', realme: 'realme', tcl: 'TCL', vivo: 'vivo', zte: 'ZTE',
};

/** `HUAWEI` -> `Huawei`, `samsung` -> `Samsung`, `OnePlus` -> `OnePlus`. */
function brandName(manufacturer) {
  const raw = String(manufacturer || '').trim();
  if (!raw) return '';
  const known = BRAND_SPELLING[raw.toLowerCase()];
  if (known) return known;
  // A name shouted or whispered by the property gets title cased; one that
  // already carries its own capitals is left exactly as the vendor wrote it.
  if (raw === raw.toUpperCase() || raw === raw.toLowerCase()) {
    return raw.replace(/\S+/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
  }
  return raw;
}

/**
 * The name shown in the picker and used for capture filenames: the brand plus
 * the friendliest name the device offers — "Huawei P20 lite" rather than
 * "ANE-LX1", "Google Pixel 6" rather than "sdk_gphone64_arm64".
 */
function androidDisplayName(props, { isEmulator, serial }) {
  const marketName =
    props['ro.config.marketing_name'] ||
    props['ro.product.marketname'] ||
    props['ro.product.vendor.marketname'] ||
    props['ro.vendor.product.display'];
  const avdName = props['ro.boot.qemu.avd_name'] || props['ro.kernel.qemu.avd_name'];

  const base = (isEmulator ? avdName : marketName) || props['ro.product.model'] || serial;
  const name = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const brand = brandName(props['ro.product.manufacturer']);
  if (!brand || !name) return name || serial;

  // Marketing names usually carry the brand already ("HUAWEI P20 lite"), so the
  // prefix is rewritten rather than repeated — but only on a word boundary, so
  // a "vivo" device never turns a "Vivobook" into "vivobook".
  if (name.toLowerCase().startsWith(brand.toLowerCase())) {
    const rest = name.slice(brand.length);
    if (rest === '' || /^[\s-]/.test(rest)) return `${brand}${rest}`;
  }
  return `${brand} ${name}`;
}

/**
 * Which recorder an Android device needs, cached per serial.
 *
 * `screenrecord` is a stock AOSP utility, but it is not guaranteed to be on the
 * device. Huawei's EMUI images ship no `/system/bin/screenrecord` at all — they
 * bundle their own recorder app instead — and the device's shell answers
 * "screenrecord: not found". Android Studio's screen recorder fails on those
 * devices for exactly this reason, so the app has to ask rather than assume.
 */
const recordSupport = new Map();

async function androidRecordSupport(serial) {
  if (recordSupport.has(serial)) return recordSupport.get(serial);

  const adb = findBinary('adb');
  if (!adb) return { screenrecord: false, unlimited: false, unknown: true };

  const help = await run(adb, ['-s', serial, 'shell', 'screenrecord', '--help'], { timeout: 10000 });
  const text = `${help.stdout}${help.stderr}`;

  // The device's own shell disowning the command is the one reliable sign that
  // the binary is absent. `adb: device '<serial>' not found` carries the same
  // words, hence anchoring the match to the command name.
  if (/screenrecord:\s*(not found|inaccessible|No such file)/i.test(text)) {
    const support = { screenrecord: false, unlimited: false };
    recordSupport.set(serial, support);
    return support;
  }

  // Every build that has it prints this usage (to stderr, and exits 0). Anything
  // else means the probe never landed — device unplugged, adb restarting — so it
  // is left uncached and asked again on the next refresh.
  if (!/Usage:\s*screenrecord/i.test(text)) return { screenrecord: true, unlimited: false, unknown: true };

  // Android 11+ accepts `--time-limit 0`; older builds cap every clip at 3 minutes.
  const support = { screenrecord: true, unlimited: /Set to 0/i.test(text) };
  recordSupport.set(serial, support);
  return support;
}

/** How a device can be recorded — and why it cannot be, when it cannot. */
function recordRoute(support) {
  if (support.screenrecord) return { canRecord: true, recordVia: 'screenrecord' };
  // scrcpy runs its own server on the device and drives MediaCodec directly, so
  // it records fine where the system image simply has no screenrecord binary.
  if (findBinary('scrcpy')) return { canRecord: true, recordVia: 'scrcpy' };
  return {
    canRecord: false,
    recordVia: null,
    recordNote: 'This ROM ships no screenrecord. Run `brew install scrcpy` to record this device.',
  };
}

async function listAndroid() {
  const adb = findBinary('adb');
  if (!adb) return [];

  const { stdout, failed } = await run(adb, ['devices', '-l'], { timeout: 10000 });
  if (failed) return [];

  const devices = [];
  for (const line of stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state] = trimmed.split(/\s+/);
    if (!serial) continue;

    const isEmulator = serial.startsWith('emulator-');
    const base = {
      id: `android:${serial}`,
      platform: 'android',
      kind: isEmulator ? 'emulator' : 'device',
      serial,
      name: serial,
      osVersion: '',
      ready: false,
      canRecord: false,
    };

    if (state !== 'device') {
      // "unauthorized" = USB debugging prompt not accepted; "offline" = booting or stale.
      devices.push({
        ...base,
        note:
          state === 'unauthorized'
            ? 'Unauthorized — accept the USB debugging prompt on the device'
            : `Unavailable (${state})`,
      });
      continue;
    }

    const query = await run(
      adb,
      ['-s', serial, 'shell', ANDROID_PROPS.map((name) => `getprop ${name}`).join('; ')],
      { timeout: 10000 },
    );
    const lines = query.stdout.split('\n');
    const props = Object.fromEntries(ANDROID_PROPS.map((name, i) => [name, (lines[i] || '').trim()]));
    const release = props['ro.build.version.release'];
    devices.push({
      ...base,
      name: androidDisplayName(props, { isEmulator, serial }),
      osVersion: release ? `Android ${release}` : '',
      ready: true,
      ...recordRoute(await androidRecordSupport(serial)),
    });
  }
  return devices;
}

/* ------------------------------------------------- iOS Simulators (simctl) */

async function listSimulators() {
  const xcrun = findBinary('xcrun');
  if (!xcrun) return [];

  const { stdout, failed } = await run(xcrun, ['simctl', 'list', 'devices', '--json'], { timeout: 20000 });
  if (failed) return [];

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const devices = [];
  for (const [runtime, entries] of Object.entries(parsed.devices || {})) {
    // Runtime keys look like "com.apple.CoreSimulator.SimRuntime.iOS-26-5".
    const match = /SimRuntime\.(iOS|tvOS|watchOS|xrOS)-([\d-]+)$/.exec(runtime);
    if (!match || match[1] !== 'iOS') continue;
    const version = match[2].replace(/-/g, '.');

    for (const entry of entries) {
      if (entry.isAvailable === false) continue;
      const booted = entry.state === 'Booted';
      devices.push({
        id: `simulator:${entry.udid}`,
        platform: 'ios',
        kind: 'simulator',
        serial: entry.udid,
        name: entry.name,
        osVersion: `iOS ${version}`,
        ready: booted,
        canRecord: true,
        note: booted ? undefined : 'Not booted — start it in Simulator first',
      });
    }
  }
  // Booted simulators first, then alphabetically.
  return devices.sort((a, b) => Number(b.ready) - Number(a.ready) || a.name.localeCompare(b.name));
}

/* ------------------------------------------- Physical iPhones / iPads (USB) */

/** Video inputs exposed by AVFoundation, as `{ index, name }`. A tethered, unlocked
 *  iPhone shows up here — that is the same pipe QuickTime's "Movie Recording" uses. */
async function listAvfoundationInputs() {
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg) return [];

  // ffmpeg prints the device list to stderr and then exits non-zero by design.
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    timeout: 15000,
  });

  const inputs = [];
  let inVideoSection = false;
  for (const line of stderr.split('\n')) {
    if (line.includes('AVFoundation video devices:')) { inVideoSection = true; continue; }
    if (line.includes('AVFoundation audio devices:')) { inVideoSection = false; continue; }
    if (!inVideoSection) continue;
    const match = /\[(\d+)\]\s+(.+?)\s*$/.exec(line.replace(/^\[AVFoundation indev @ [^\]]+\]\s*/, ''));
    if (match) inputs.push({ index: match[1], name: match[2] });
  }
  return inputs;
}

/** Connected physical Apple devices via devicectl (Xcode 15+), falling back to xctrace. */
async function listPhysicalApple() {
  const xcrun = findBinary('xcrun');
  if (!xcrun) return [];

  const outFile = path.join(os.tmpdir(), `dsr-devicectl-${process.pid}.json`);
  const result = await run(xcrun, ['devicectl', 'list', 'devices', '--json-output', outFile], { timeout: 20000 });

  if (!result.failed) {
    try {
      const json = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      fs.rmSync(outFile, { force: true });
      return (json?.result?.devices || [])
        .filter((d) => /iphone|ipad|ipod/i.test(d?.hardwareProperties?.deviceType || d?.deviceProperties?.name || ''))
        .map((d) => ({
          name: d.deviceProperties?.name || 'iOS device',
          udid: d.hardwareProperties?.udid || d.identifier,
          osVersion: d.deviceProperties?.osVersionNumber ? `iOS ${d.deviceProperties.osVersionNumber}` : 'iOS',
          connected: d.connectionProperties?.tunnelState !== 'unavailable',
        }));
    } catch {
      /* fall through to xctrace */
    }
  }
  fs.rmSync(outFile, { force: true });

  const trace = await run(xcrun, ['xctrace', 'list', 'devices'], { timeout: 20000 });
  if (trace.failed) return [];
  const devices = [];
  for (const line of trace.stdout.split('\n')) {
    if (line.includes('== Simulators ==')) break;
    // "Andrii's iPhone (18.0) (00008120-000...)" — the Mac has no OS version in parentheses.
    const match = /^(.+?)\s+\(([\d.]+)\)\s+\(([0-9A-Fa-f-]{8,})\)\s*$/.exec(line.trim());
    if (match) devices.push({ name: match[1], osVersion: `iOS ${match[2]}`, udid: match[3], connected: true });
  }
  return devices;
}

/** Names AVFoundation reports for the Mac's own hardware — never an iOS device. */
const MAC_INPUT = /^(FaceTime|Capture screen|Desk View|.*Studio Display.*|.*Continuity Camera.*|.*Virtual Camera.*)/i;

async function listPhysicalIos() {
  const [apple, avInputs] = await Promise.all([listPhysicalApple(), listAvfoundationInputs()]);
  const capturable = avInputs.filter((i) => !MAC_INPUT.test(i.name));

  const devices = apple.map((d) => {
    const av = capturable.find((i) => i.name === d.name) || capturable.find((i) => i.name.includes(d.name));
    return {
      id: `ios:${d.udid}`,
      platform: 'ios',
      kind: 'device',
      serial: d.udid,
      name: d.name,
      osVersion: d.osVersion,
      ready: Boolean(av),
      canRecord: true,
      avIndex: av?.index,
      note: av ? undefined : 'Connect by USB, unlock the device and trust this Mac',
    };
  });

  // Deliberately no fallback that lists unmatched AVFoundation inputs as devices:
  // any USB webcam or capture card also shows up there, and offering one would
  // mean this app could record a camera rather than a device screen. An input is
  // only ever capturable when devicectl or xctrace confirms a real Apple device
  // of that name is attached.
  return devices;
}

/* --------------------------------------------------------------- aggregate */

async function listDevices() {
  const [android, simulators, physicalIos] = await Promise.all([
    listAndroid(),
    listSimulators(),
    listPhysicalIos(),
  ]);
  return [...android, ...physicalIos, ...simulators];
}

function toolStatus() {
  return {
    adb: Boolean(findBinary('adb')),
    xcrun: Boolean(findBinary('xcrun')),
    ffmpeg: Boolean(findBinary('ffmpeg')),
    scrcpy: Boolean(findBinary('scrcpy')),
  };
}

module.exports = { listDevices, toolStatus, listAvfoundationInputs, androidRecordSupport };
