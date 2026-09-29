'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { ENV, run, runBinary, findBinary, sleep, slug, timestamp, uniquePath } = require('./util.cjs');
const { androidRecordSupport } = require('./devices.cjs');

/** deviceId -> live recording session. One recording per device, several devices at once. */
const sessions = new Map();

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const VIDEO_EXT = { mov: '.mov', mp4: '.mp4' };

/** Frame rate every recording is normalised to before it is written out. */
const OUTPUT_FPS = 30;

class CaptureError extends Error {}

function fail(message, detail) {
  const clean = String(detail || '').trim().split('\n').filter(Boolean).slice(-3).join(' — ');
  throw new CaptureError(clean ? `${message}: ${clean}` : message);
}

/** Wait for a spawned child, collecting stderr. */
function waitFor(child) {
  return new Promise((resolve) => {
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.stdout?.on('data', () => {});
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

/* ================================================================ SCREENSHOTS */

async function takeScreenshot(device, settings) {
  const outPath = uniquePath(settings.outputDir, `${slug(device.name)}_${timestamp()}`, '.png');

  if (device.platform === 'android') await androidScreenshot(device, outPath);
  else if (device.kind === 'simulator') await simulatorScreenshot(device, outPath);
  else await iosDeviceScreenshot(device, outPath);

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    fs.rmSync(outPath, { force: true });
    fail('Screenshot produced an empty file');
  }
  return outPath;
}

async function androidScreenshot(device, outPath) {
  const adb = findBinary('adb');
  if (!adb) fail('adb was not found on this Mac');

  // `exec-out` streams raw bytes, unlike `shell` which mangles line endings on old devices.
  const direct = await runBinary(adb, ['-s', device.serial, 'exec-out', 'screencap', '-p']);
  if (!direct.failed && direct.stdout.length > 8 && direct.stdout.subarray(0, 4).equals(PNG_MAGIC)) {
    fs.writeFileSync(outPath, direct.stdout);
    return;
  }

  // Fallback for devices where exec-out is unavailable or corrupts the stream.
  const remote = `/data/local/tmp/dsr-shot-${Date.now()}.png`;
  const capture = await run(adb, ['-s', device.serial, 'shell', 'screencap', '-p', remote]);
  if (capture.failed) fail('adb screencap failed', capture.stderr || direct.stderr);
  const pull = await run(adb, ['-s', device.serial, 'pull', remote, outPath]);
  await run(adb, ['-s', device.serial, 'shell', 'rm', '-f', remote]);
  if (pull.failed) fail('Could not pull the screenshot from the device', pull.stderr);
}

async function simulatorScreenshot(device, outPath) {
  const xcrun = findBinary('xcrun');
  if (!xcrun) fail('xcrun was not found — install Xcode command line tools');
  const result = await run(xcrun, ['simctl', 'io', device.serial, 'screenshot', '--type', 'png', outPath]);
  if (result.failed) fail('simctl screenshot failed', result.stderr);
}

async function iosDeviceScreenshot(device, outPath) {
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg) fail('ffmpeg is required to capture a physical iPhone or iPad (brew install ffmpeg)');
  if (device.avIndex == null) fail('This device is not offering a video stream — unlock it and trust this Mac');
  if (sessions.has(device.id)) fail('Stop the recording first — macOS gives one process at a time access to the device');

  // AVFoundation needs a moment to negotiate the stream, so grab a frame a little
  // way in rather than the very first one, which is often black.
  const result = await run(ffmpeg, [
    '-hide_banner', '-y',
    '-f', 'avfoundation',
    '-i', device.avIndex,
    '-an',
    '-frames:v', '1',
    '-update', '1',
    outPath,
  ], { timeout: 30000 });
  if (result.failed) fail('ffmpeg could not grab a frame from the device', result.stderr);
}

/* ================================================================= RECORDING */

function isRecording(deviceId) {
  return sessions.has(deviceId);
}

function activeRecordings() {
  return [...sessions.values()].map((s) => ({
    deviceId: s.deviceId,
    startedAt: s.startedAt,
    outPath: s.outPath,
    stopping: s.stopping,
  }));
}

async function startRecording(device, settings) {
  if (sessions.has(device.id)) fail('This device is already being recorded');

  const extension = VIDEO_EXT[settings.videoFormat] || VIDEO_EXT.mov;
  const outPath = uniquePath(settings.outputDir, `${slug(device.name)}_${timestamp()}`, extension);
  const session = {
    deviceId: device.id,
    device,
    settings,
    outPath,
    startedAt: Date.now(),
    stopping: false,
    // Recorders write here first; the finished file is normalised into outPath.
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-')),
    rawPath: null,
    // When frames actually started arriving, which is a beat after startedAt.
    captureStartedAt: null,
  };
  sessions.set(device.id, session);

  try {
    if (device.platform === 'android' && settings.showTouches) {
      session.restoreTouches = await enableShowTouches(device.serial);
    }
    if (device.platform === 'android') await startAndroidRecording(session);
    else if (device.kind === 'simulator') {
      // Build the tap tracker before the clock starts, so the first-ever recording
      // doesn't lose its opening taps to the compile.
      if (settings.showTouches) await touchHelper();
      await startSimulatorRecording(session);
      if (settings.showTouches) await startTouchLog(session);
    } else await startIosDeviceRecording(session);
  } catch (err) {
    session.touchLog?.stop();
    await session.restoreTouches?.();
    fs.rmSync(session.workDir, { recursive: true, force: true });
    sessions.delete(device.id);
    throw err;
  }
  return { outPath, startedAt: session.startedAt };
}

async function stopRecording(deviceId) {
  const session = sessions.get(deviceId);
  if (!session) fail('That device is not recording');
  if (session.stopping) fail('Already finishing that recording');
  session.stopping = true;

  const stoppedAt = Date.now();
  try {
    session.touchLog?.stop();
    await session.stop();
    if (!session.rawPath || !fs.existsSync(session.rawPath) || fs.statSync(session.rawPath).size === 0) {
      fail('The recording came back empty');
    }

    const wallClockSeconds = (stoppedAt - (session.captureStartedAt || session.startedAt)) / 1000;
    await finalizeVideo(session, wallClockSeconds);
    if (session.touchLog?.events.length) await drawTouches(session);

    if (!fs.existsSync(session.outPath) || fs.statSync(session.outPath).size === 0) {
      fs.rmSync(session.outPath, { force: true });
      fail('The recording came back empty');
    }
    return { outPath: session.outPath, durationMs: stoppedAt - session.startedAt };
  } finally {
    session.touchLog?.stop();
    await session.restoreTouches?.();
    fs.rmSync(session.workDir, { recursive: true, force: true });
    sessions.delete(deviceId);
  }
}

/** Stop everything still running — used when the window closes. */
async function stopAll() {
  await Promise.allSettled([...sessions.keys()].map((id) => stopRecording(id)));
}


/* ------------------------------------------------------- finishing a clip */

/** Duration in seconds, or null when the file carries no usable timeline. */
async function probeDuration(filePath) {
  const ffprobe = findBinary('ffprobe');
  if (!ffprobe) return null;
  const result = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    filePath,
  ], { timeout: 30000 });
  const seconds = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Turn the recorder's raw output into the file the user asked for.
 *
 * Both `screenrecord` and `simctl` emit frames only when the screen actually
 * changes, and they stop the timeline at the last change. So a clip of a still
 * screen ends up as a single frame with no duration at all — which is exactly
 * the file QuickTime refuses to open — and any clip that ends on a static screen
 * loses its tail. Padding with the last frame up to the real elapsed time and
 * writing constant frame rate fixes both.
 */
async function finalizeVideo(session, wallClockSeconds) {
  const { rawPath, outPath, device, settings } = session;
  const ffmpeg = findBinary('ffmpeg');

  if (!ffmpeg) {
    // Without ffmpeg the best we can do is hand over what the recorder produced.
    fs.copyFileSync(rawPath, outPath);
    return;
  }

  const bitrate = `${(device.platform === 'android' ? settings.androidBitrateMbps : settings.iosBitrateMbps) || 8}M`;
  // `-map 0:v:0` takes the video track and nothing else; -an/-dn/-sn make it
  // explicit that no audio, data or subtitle stream can ever reach the output.
  // Without these, ffmpeg's default stream selection would carry over an audio
  // track if a recorder ever produced one.
  const SILENT = ['-map', '0:v:0', '-an', '-dn', '-sn'];
  const encode = [...SILENT, '-c:v', 'h264_videotoolbox', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  const duration = await probeDuration(rawPath);
  const target = Math.max(wallClockSeconds || 0, 0.2);

  let args;
  if (duration === null) {
    // A single frame with no timeline: re-time it and hold it for the whole clip.
    args = [
      '-hide_banner', '-v', 'error', '-y',
      '-r', String(OUTPUT_FPS), '-i', rawPath,
      '-vf', `tpad=stop_mode=clone:stop_duration=${target.toFixed(2)},fps=${OUTPUT_FPS}`,
      ...encode, outPath,
    ];
  } else if (Math.abs(duration - target) < 0.3) {
    // Already the length of the take — just move it into the requested container.
    args = [
      '-hide_banner', '-v', 'error', '-y', '-i', rawPath,
      ...SILENT, '-c', 'copy', '-movflags', '+faststart', outPath,
    ];
  } else {
    // Pad a short tail, and trim if the recorder overstates the length — some
    // devices report a track far longer than the take actually ran for. `-t`
    // pins the result to the time that really elapsed either way.
    const padding = Math.min(Math.max(target - duration, 0), 600);
    args = [
      '-hide_banner', '-v', 'error', '-y', '-i', rawPath,
      '-vf', `fps=${OUTPUT_FPS},tpad=stop_mode=clone:stop_duration=${padding.toFixed(2)}`,
      '-t', target.toFixed(2),
      ...encode, outPath,
    ];
  }

  const result = await run(ffmpeg, args, { timeout: 600000 });
  if (result.failed || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    // Never lose a take over a post-processing problem.
    fs.copyFileSync(rawPath, outPath);
  }
}

/* ------------------------------------------------------------------ Android */

/**
 * Switch on the device's "Show taps" developer setting — what Android Studio does
 * for its recordings. Android draws the dots into the display itself, so every
 * recorder picks them up. Returns a function that puts the old value back; it is
 * a no-op when the setting was already on, and never throws.
 */
async function enableShowTouches(serial) {
  const adb = findBinary('adb');
  if (!adb) return null;
  const current = await run(adb, ['-s', serial, 'shell', 'settings', 'get', 'system', 'show_touches'], { timeout: 10000 });
  const previous = current.failed ? '0' : current.stdout.trim();
  if (previous === '1') return null;

  const set = await run(adb, ['-s', serial, 'shell', 'settings', 'put', 'system', 'show_touches', '1'], { timeout: 10000 });
  if (set.failed) return null; // a missing dot is no reason to refuse the recording

  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    // A device unplugged mid-take just keeps showing taps — harmless.
    const value = /^\d+$/.test(previous) ? previous : '0';
    await run(adb, ['-s', serial, 'shell', 'settings', 'put', 'system', 'show_touches', value], { timeout: 10000 });
  };
}

async function startAndroidRecording(session) {
  const adb = findBinary('adb');
  if (!adb) fail('adb was not found on this Mac');

  const { serial } = session.device;
  const support = await androidRecordSupport(serial);
  // Vendor images that ship no screenrecord binary at all (EMUI, notably) are
  // recorded through scrcpy instead, which brings its own recorder to the device.
  if (!support.screenrecord) return startScrcpyRecording(session);

  const unlimited = support.unlimited;
  const bitrate = `${session.settings.androidBitrateMbps || 8}M`;
  const remotePrefix = `/data/local/tmp/dsr-${Date.now()}`;
  const remoteFiles = [];
  let segmentError = null;

  // screenrecord writes straight to the device; on pre-Android 11 it hard-stops at
  // 180s, so we chain segments back-to-back and stitch them together on stop.
  const loop = (async () => {
    for (let i = 0; !session.stopping; i++) {
      const remote = `${remotePrefix}-${String(i).padStart(3, '0')}.mp4`;
      const args = [
        '-s', serial, 'shell', 'screenrecord',
        '--bit-rate', bitrate,
        '--time-limit', unlimited ? '0' : '180',
        remote,
      ];
      const child = spawn(adb, args, { env: ENV });
      session.child = child;
      session.captureStartedAt ??= Date.now();
      remoteFiles.push(remote);

      const { code, stderr } = await waitFor(child);
      // A clean stop kills screenrecord with SIGINT, which adb reports as a failure.
      if (code !== 0 && !session.stopping) {
        segmentError = stderr || `screenrecord exited with code ${code}`;
        break;
      }
      if (unlimited) break;
    }
  })();

  // Surface an immediate failure (bad flag, device unplugged) instead of pretending
  // the recording started.
  await Promise.race([loop, sleep(900)]);
  if (segmentError) fail('screenrecord failed to start', segmentError);

  session.stop = async () => {
    // Signalling screenrecord on the device is what makes it write a valid moov atom;
    // killing the local adb process would leave a truncated file behind.
    const killed = await run(adb, ['-s', serial, 'shell', 'pkill', '-INT', 'screenrecord'], { timeout: 10000 });
    if (killed.failed) await run(adb, ['-s', serial, 'shell', 'killall', '-INT', 'screenrecord'], { timeout: 10000 });

    await Promise.race([loop, sleep(15000)]);
    await sleep(700); // let the device flush the trailer

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-'));
    const localFiles = [];
    try {
      for (const remote of remoteFiles) {
        const local = path.join(tmpDir, path.basename(remote));
        const pull = await run(adb, ['-s', serial, 'pull', remote, local], { timeout: 120000 });
        await run(adb, ['-s', serial, 'shell', 'rm', '-f', remote]);
        if (!pull.failed && fs.existsSync(local) && fs.statSync(local).size > 0) localFiles.push(local);
      }
      if (localFiles.length === 0) fail('Nothing was recorded on the device', segmentError);
      session.rawPath = path.join(session.workDir, 'android.mp4');
      await joinSegments(localFiles, session.rawPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

/** One segment is just moved into place; several are concatenated without re-encoding. */
async function joinSegments(files, outPath) {
  if (files.length === 1) {
    fs.copyFileSync(files[0], outPath);
    return;
  }
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg) {
    // Better to hand over the first three minutes than nothing at all.
    fs.copyFileSync(files[0], outPath);
    fail('Recording ran past 3 minutes and ffmpeg is not installed, so only the first segment was kept');
  }
  const listFile = path.join(path.dirname(files[0]), 'segments.txt');
  fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const result = await run(ffmpeg, [
    '-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-map', '0:v:0', '-an', '-dn', '-sn', '-c', 'copy', outPath,
  ]);
  if (result.failed) fail('Could not join the recorded segments', result.stderr);
}

/* --------------------------------------------- Android without screenrecord */

let scrcpyFlagsCache = null;

/** Flag spellings changed in scrcpy 2.0, so ask whichever binary is installed. */
async function scrcpyFlags(scrcpy) {
  if (scrcpyFlagsCache) return scrcpyFlagsCache;
  const help = await run(scrcpy, ['--help'], { timeout: 15000 });
  const text = `${help.stdout}${help.stderr}`;
  scrcpyFlagsCache = {
    noPlayback: text.includes('--no-playback') ? '--no-playback' : '--no-display',
    bitRate: text.includes('--video-bit-rate') ? '--video-bit-rate' : '--bit-rate',
    // Audio capture, and the flag to refuse it, only exist from scrcpy 2.0 on.
    noAudio: text.includes('--no-audio'),
  };
  return scrcpyFlagsCache;
}

/**
 * The recorder for devices whose ROM has no `screenrecord`. scrcpy pushes a
 * server jar to /data/local/tmp on the device and drives MediaCodec and the
 * display service from there, so it needs nothing from the system image beyond
 * a hardware encoder — which is why it works where screenrecord is missing.
 */
async function startScrcpyRecording(session) {
  const scrcpy = findBinary('scrcpy');
  if (!scrcpy) {
    fail('This device ships no screenrecord, so recording it needs scrcpy (brew install scrcpy)');
  }

  const { serial } = session.device;
  const flags = await scrcpyFlags(scrcpy);
  session.rawPath = path.join(session.workDir, 'android-scrcpy.mp4');

  const child = spawn(scrcpy, [
    '--serial', serial,
    flags.noPlayback,               // no mirroring window — this is a recorder
    '--no-control',                 // never inject a touch or a key into the device
    ...(flags.noAudio ? ['--no-audio'] : []),
    `${flags.bitRate}=${session.settings.androidBitrateMbps || 8}M`,
    `--record=${session.rawPath}`,
  ], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  session.child = child;
  const done = waitFor(child);

  /**
   * scrcpy ignores SIGINT and SIGTERM when it runs without a window, and killing
   * it outright leaves an mp4 with no moov atom, which nothing can play. Ending
   * the stream underneath it is what makes it finalise: its adb child holds the
   * socket to the on-device server, so closing that reads as a clean end of
   * stream and scrcpy writes the trailer on its way out.
   */
  const endStream = async () => {
    const pgrep = findBinary('pgrep');
    if (pgrep && child.pid) {
      const kids = await run(pgrep, ['-P', String(child.pid)], { timeout: 5000 });
      for (const pid of kids.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
        try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
      }
    }
    if (await Promise.race([done, sleep(15000).then(() => null)])) return;

    // Nothing local left to close, so stop the server on the device instead.
    const adb = findBinary('adb');
    if (adb) {
      await run(adb, ['-s', serial, 'shell', 'pkill', '-f', 'com.genymobile.scrcpy.Server'], { timeout: 10000 });
      if (await Promise.race([done, sleep(10000).then(() => null)])) return;
    }
    child.kill('SIGKILL');
    await Promise.race([done, sleep(5000)]);
  };

  // scrcpy's own log is fully buffered when it is not attached to a terminal —
  // none of it arrives until the process exits — so the recording file is the
  // signal instead: it appears and takes its mp4 header the moment frames start
  // being written, about a second in, once the server is up and streaming.
  let settled = false;
  const framesFlowing = (async () => {
    for (let waited = 0; waited < 15000 && !settled; waited += 100) {
      try {
        if (fs.statSync(session.rawPath).size > 0) return 'started';
      } catch { /* not created yet */ }
      await sleep(100);
    }
    return 'timeout';
  })();

  const outcome = await Promise.race([done, framesFlowing]);
  settled = true;
  if (outcome !== 'started') {
    await endStream();
    fail(
      'scrcpy could not start recording',
      outcome === 'timeout' ? 'no frames arrived from the device' : outcome.stderr,
    );
  }
  session.captureStartedAt = Date.now();

  session.stop = async () => {
    await endStream();
    // scrcpy exits non-zero when the stream ends under it — which is exactly how
    // it is stopped here — so the file it wrote is the only thing worth checking.
    if (!fs.existsSync(session.rawPath) || fs.statSync(session.rawPath).size === 0) {
      fail('scrcpy recorded nothing');
    }
  };
}

/* ------------------------------------------------------------ iOS Simulator */

async function startSimulatorRecording(session) {
  const xcrun = findBinary('xcrun');
  if (!xcrun) fail('xcrun was not found — install Xcode command line tools');

  session.rawPath = path.join(session.workDir, 'simulator.mov');
  const child = spawn(
    xcrun,
    ['simctl', 'io', session.device.serial, 'recordVideo', '--codec', 'h264', '--force', session.rawPath],
    { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  session.child = child;
  session.captureStartedAt = Date.now();
  // Frames only start flowing at "Recording started", ~0.5s after spawn; tap
  // circles are timed against that moment so they land on the right frame.
  const markStart = (d) => {
    if (!session.videoStartedAt && d.toString().includes('Recording started')) session.videoStartedAt = Date.now();
  };
  child.stdout.on('data', markStart);
  child.stderr.on('data', markStart);
  const done = waitFor(child);

  // simctl reports "Recording started" once it has the display; an early exit means
  // it never got there (most often another recording already holds the simulator).
  const early = await Promise.race([done, sleep(1200).then(() => null)]);
  if (early) fail('simctl could not start recording', early.stderr);

  session.stop = async () => {
    child.kill('SIGINT'); // simctl finalises the file on SIGINT
    const result = await Promise.race([done, sleep(30000).then(() => ({ code: -1, stderr: 'timed out' }))]);
    if (result.code !== 0 && !fs.existsSync(session.rawPath)) fail('simctl recording failed', result.stderr);
  };
}

/* ---------------------------------------------- Simulator tap circles */

/*
 * simctl records the simulated display only, so the Simulator's own touch dots
 * (drawn on its Mac window) never reach the file. Instead touches.swift watches
 * the Mac pointer pressing on the device screen, and drawTouches() paints a
 * circle at those spots once the video is finished.
 */

/** touches.swift is compiled on first use and cached per source version. */
let touchHelperPromise = null;

function touchHelper() {
  touchHelperPromise ??= (async () => {
    const source = fs.readFileSync(path.join(__dirname, 'touches.swift'), 'utf8');
    const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 10);
    const binary = path.join(app.getPath('userData'), 'bin', `touches-${hash}`);
    if (fs.existsSync(binary)) return binary;

    const xcrun = findBinary('xcrun');
    if (!xcrun) return null;
    // swiftc cannot read from inside app.asar, so compile a plain copy.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-swift-'));
    try {
      const src = path.join(tmp, 'touches.swift');
      fs.writeFileSync(src, source);
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      const built = await run(xcrun, ['swiftc', '-O', src, '-o', binary], { timeout: 180000 });
      if (built.failed) {
        console.warn('Could not build the tap tracker:', built.stderr);
        return null;
      }
      // Drop builds of older sources.
      for (const old of fs.readdirSync(path.dirname(binary))) {
        if (old.startsWith('touches-') && old !== path.basename(binary)) {
          fs.rmSync(path.join(path.dirname(binary), old), { force: true });
        }
      }
      return binary;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
  // A failed build is retried on the next recording rather than cached forever.
  touchHelperPromise.then((bin) => { if (!bin) touchHelperPromise = null; });
  return touchHelperPromise;
}

async function startTouchLog(session) {
  const binary = await touchHelper();
  if (!binary) return;

  // Simulator titles its windows "<device name> – <OS version>".
  const { name, osVersion } = session.device;
  const child = spawn(binary, [`${name} – ${osVersion}`], { stdio: ['pipe', 'pipe', 'ignore'] });
  const log = { events: [], stop: () => { if (child.exitCode === null) child.kill(); } };
  session.touchLog = log;

  let buffer = '';
  child.stdout.on('data', (d) => {
    buffer += d.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.error) console.warn('Tap tracker:', event.error);
        else if (event.type) log.events.push(event);
      } catch { /* not a JSON line */ }
    }
  });
  child.on('error', (err) => console.warn('Tap tracker failed:', err.message));
}

async function probeSize(filePath) {
  const ffprobe = findBinary('ffprobe');
  if (!ffprobe) return null;
  const result = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x',
    filePath,
  ], { timeout: 30000 });
  const [width, height] = result.stdout.trim().split('x').map(Number);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Shortest time a circle stays up, so a quick click still shows for a few frames. */
const MIN_TAP_SECONDS = 0.25;

/**
 * Overlay one circle that sendcmd moves to each logged position and parks
 * off-frame between presses. Re-encodes outPath in place; on any problem the
 * clip is simply kept without circles.
 */
async function drawTouches(session) {
  const ffmpeg = findBinary('ffmpeg');
  const size = await probeSize(session.outPath);
  if (!ffmpeg || !size) return;

  const origin = session.videoStartedAt || session.captureStartedAt || session.startedAt;
  const diameter = Math.round((size.width * 0.09) / 2) * 2;
  const hide = 'overlay@tap x -10000, overlay@tap y -10000';
  const move = (e) =>
    `overlay@tap x ${Math.round(e.x * size.width - diameter / 2)}, overlay@tap y ${Math.round(e.y * size.height - diameter / 2)}`;

  // Each press becomes back-to-back [from, to) intervals; sendcmd needs explicit ends.
  const commands = [];
  let cursor = 0;
  let press = [];
  const flush = () => {
    if (!press.length) return;
    const times = press.map((e) => Math.max((e.t - origin) / 1000, cursor));
    const end = Math.max(times[times.length - 1], times[0] + MIN_TAP_SECONDS);
    if (times[0] > cursor) commands.push([cursor, times[0], hide]);
    press.forEach((e, i) => {
      const to = i + 1 < press.length ? times[i + 1] : end;
      if (to > times[i]) commands.push([times[i], to, move(e)]);
    });
    cursor = end;
    press = [];
  };
  for (const e of session.touchLog.events) {
    if (e.type === 'down') flush();
    press.push(e);
    if (e.type === 'up') flush();
  }
  flush();
  commands.push([cursor, cursor + 86400, hide]);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-taps-'));
  try {
    const circle = path.join(tmp, 'circle.png');
    const cmdFile = path.join(tmp, 'taps.cmd');
    const r = diameter / 2;
    const dist = `hypot(X-${r}+0.5,Y-${r}+0.5)`;
    const rim = Math.max(2, Math.round(diameter / 22));
    // A translucent dark disc with a white rim, so it reads on light and dark screens.
    const onRim = `gte(${dist},${r - rim})`;
    const shade = `if(${onRim},255,40)`;
    const made = await run(ffmpeg, [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black@0:s=${diameter}x${diameter},format=rgba`,
      '-frames:v', '1',
      '-vf', `geq=r='${shade}':g='${shade}':b='${shade}':a='if(lte(${dist},${r - 1}),if(${onRim},230,110),0)'`,
      circle,
    ]);
    if (made.failed) return;
    fs.writeFileSync(cmdFile, commands.map(([from, to, cmd]) => `${from.toFixed(3)}-${to.toFixed(3)} ${cmd};`).join('\n'));

    const drawn = path.join(tmp, `drawn${path.extname(session.outPath)}`);
    // The clip can still be variable-rate (a still screen has almost no frames), so
    // resample first or a tap could land between frames. The overlay starts at 0,0
    // and the t=0 command parks it: starting it off-frame through its own options
    // makes every later move silently do nothing.
    const result = await run(ffmpeg, [
      '-hide_banner', '-v', 'error', '-y',
      '-i', session.outPath, '-loop', '1', '-i', circle,
      '-filter_complex', `[0:v]fps=${OUTPUT_FPS},sendcmd=f=${cmdFile}[v];[v][1:v]overlay@tap=x=0:y=0:shortest=1[out]`,
      // Only the drawn video: mapping 0:v would add the untouched track beside it.
      '-map', '[out]', '-an', '-dn', '-sn',
      '-c:v', 'h264_videotoolbox', '-b:v', `${session.settings.iosBitrateMbps || 10}M`,
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      drawn,
    ], { timeout: 600000 });
    if (result.failed || !fs.existsSync(drawn) || fs.statSync(drawn).size === 0) {
      console.warn(`Could not draw taps on ${session.device.name}:`, result.stderr);
      return;
    }
    fs.copyFileSync(drawn, session.outPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------------------------ Physical iPhone / iPad */

async function startIosDeviceRecording(session) {
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg) fail('ffmpeg is required to record a physical iPhone or iPad (brew install ffmpeg)');
  if (session.device.avIndex == null) {
    fail('This device is not offering a video stream — unlock it and trust this Mac');
  }

  // AVFoundation hands us the device's live screen (the same feed QuickTime uses);
  // VideoToolbox keeps the re-encode off the CPU.
  session.rawPath = path.join(session.workDir, 'ios-device.mov');
  const child = spawn(ffmpeg, [
    '-hide_banner', '-y',
    '-f', 'avfoundation',
    '-i', session.device.avIndex,   // video index only; a "video:audio" spec is never built
    '-an',                          // never open or record an audio track
    '-c:v', 'h264_videotoolbox',
    '-b:v', `${session.settings.iosBitrateMbps || 10}M`,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    session.rawPath,
  ], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  session.child = child;
  session.captureStartedAt = Date.now();
  const done = waitFor(child);

  const early = await Promise.race([done, sleep(1500).then(() => null)]);
  if (early) fail('ffmpeg could not open the device stream', early.stderr);

  session.stop = async () => {
    // "q" on stdin is ffmpeg's graceful stop — it writes the index before exiting.
    try { child.stdin.write('q'); } catch { /* already gone */ }
    const result = await Promise.race([done, sleep(10000).then(() => null)]);
    if (!result) {
      child.kill('SIGINT');
      await Promise.race([done, sleep(10000)]);
    }
  };
}

module.exports = { takeScreenshot, startRecording, stopRecording, stopAll, isRecording, activeRecordings, CaptureError };
