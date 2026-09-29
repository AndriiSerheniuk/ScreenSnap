import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DevicePicker from './DevicePicker.jsx';

const REFRESH_MS = 4000;

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function basename(filePath) {
  return String(filePath).split('/').pop();
}

/** `~/Desktop/Captures` reads better than the absolute path in a narrow window. */
function tildify(filePath, home) {
  return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

/** Wrap in LRE/PDF so the rtl truncation in .path does not reorder the segments. */
const ltr = (text) => `\u202a${text}\u202c`;

function CameraIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1.1-1.9A1 1 0 0 1 9.2 3.6h5.6a1 1 0 0 1 .9.5L16.8 6h1.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-8Z" />
      <circle cx="12" cy="12.4" r="3.4" />
    </svg>
  );
}

export default function App() {
  const [devices, setDevices] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [settings, setSettings] = useState(null);
  const [tools, setTools] = useState(null);
  const [version, setVersion] = useState('');
  const [recording, setRecording] = useState(null); // { deviceId, startedAt }
  const [busy, setBusy] = useState(null); // 'start' | 'stop' | 'screenshot'
  const [message, setMessage] = useState(null); // { kind, text, path? }
  const [showOptions, setShowOptions] = useState(false);
  const [copied, setCopied] = useState(null); // { at, target: 'folder' | 'capture' }
  const [now, setNow] = useState(Date.now());

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const bodyRef = useRef(null);

  const selected = devices.find((d) => d.id === selectedId) || null;
  const home = settings?.home;

  // Grow and shrink the window with the content, so expanding Options does not
  // leave the panel scrolling inside a fixed frame.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return undefined;
    const report = () => window.api.fitWindowHeight(Math.ceil(element.scrollHeight));
    const observer = new ResizeObserver(report);
    observer.observe(element);
    report();
    return () => observer.disconnect();
  }, []);

  /* ------------------------------------------------------------- loading */

  const refreshDevices = useCallback(async () => {
    const result = await window.api.listDevices();
    if (!result.ok) return;
    setDevices(result.devices);
    setRecording(result.active[0] ? { deviceId: result.active[0].deviceId, startedAt: result.active[0].startedAt } : null);

    // Keep a selection alive: prefer what is already picked, otherwise the first
    // device that can actually be captured.
    const current = result.devices.find((d) => d.id === selectedIdRef.current);
    if (!current || !current.ready) {
      const fallback = result.devices.find((d) => d.ready);
      if (fallback && (!current || !current.ready)) setSelectedId(fallback.id);
      else if (!fallback && !current) setSelectedId(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const [settingsResult, toolsResult, versionResult] = await Promise.all([
        window.api.getSettings(),
        window.api.toolStatus(),
        window.api.getVersion(),
      ]);
      if (settingsResult.ok) setSettings(settingsResult.settings);
      if (toolsResult.ok) setTools(toolsResult.tools);
      if (versionResult.ok) setVersion(versionResult.version);
      await refreshDevices();
    })();
  }, [refreshDevices]);

  // Devices come and go while the app is open, so poll instead of asking the user to refresh.
  useEffect(() => {
    const id = setInterval(refreshDevices, REFRESH_MS);
    return () => clearInterval(id);
  }, [refreshDevices]);

  useEffect(() => {
    if (!recording) return undefined;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [recording]);

  /* ------------------------------------------------------------- actions */

  const run = useCallback(async (kind, fn, onSuccess) => {
    setBusy(kind);
    setMessage(null);
    try {
      const result = await fn();
      if (!result.ok) setMessage({ kind: 'error', text: result.error });
      else onSuccess?.(result);
    } finally {
      setBusy(null);
    }
  }, []);

  const startRecording = () =>
    run('start', () => window.api.startRecording(selected.id), (result) => {
      setRecording({ deviceId: selected.id, startedAt: result.startedAt });
      setMessage(null);
    });

  const stopRecording = () =>
    run('stop', () => window.api.stopRecording(recording.deviceId), (result) => {
      setRecording(null);
      setMessage({ kind: 'success', text: `Saved ${basename(result.outPath)}`, path: result.outPath });
    });

  const takeScreenshot = () =>
    run('screenshot', () => window.api.takeScreenshot(selected.id), (result) => {
      setMessage({ kind: 'success', text: `Saved ${basename(result.outPath)}`, path: result.outPath });
    });

  // The little "Copied" bubble clears itself; the timer is torn down if the
  // path is clicked again before it fires.
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(null), 1100);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = useCallback(async (text, target) => {
    if (!text) return;
    await window.api.copyToClipboard(text);
    setCopied({ at: Date.now(), target });
  }, []);

  const chooseFolder = async () => {
    const result = await window.api.chooseOutputDir();
    if (result.ok) setSettings(result.settings);
  };

  const patchSettings = async (patch) => {
    setSettings((s) => ({ ...s, ...patch }));
    const result = await window.api.updateSettings(patch);
    if (result.ok) setSettings(result.settings);
  };

  /* -------------------------------------------------------------- render */

  const recordingDevice = recording ? devices.find((d) => d.id === recording.deviceId) : null;
  const isRecordingSelected = recording?.deviceId === selected?.id;
  // Android and the simulators happily hand over a screenshot mid-recording; a
  // tethered iPhone gives its video stream to one process at a time.
  const screenshotBlocked =
    isRecordingSelected && selected?.platform === 'ios' && selected?.kind === 'device';
  const missingTool = useMemo(() => {
    if (!tools || !selected) return null;
    if (selected.platform === 'android' && !tools.adb) return 'adb was not found — install Android platform-tools';
    if (selected.kind === 'simulator' && !tools.xcrun) return 'xcrun was not found — install Xcode';
    if (selected.platform === 'ios' && selected.kind === 'device' && !tools.ffmpeg)
      return 'ffmpeg was not found — run `brew install ffmpeg` to capture physical devices';
    return null;
  }, [tools, selected]);

  // Some vendor ROMs (Huawei's EMUI) ship no screenrecord binary, so the device
  // is perfectly screenshottable but cannot be recorded unless scrcpy is around.
  const recordBlocked = selected?.ready && selected?.canRecord === false ? selected.recordNote : null;

  const canCapture = Boolean(selected?.ready) && !missingTool && !busy;

  return (
    <>
      <div className="titlebar" />
      <div className="app">
        <div className="app-inner" ref={bodyRef}>
        <div className="section">
          <div className="label">Device</div>
          <DevicePicker
            devices={devices}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRefresh={refreshDevices}
            showOffline={settings?.showOfflineDevices ?? false}
            onToggleOffline={(value) => patchSettings({ showOfflineDevices: value })}
            recordingId={recording?.deviceId ?? null}
          />
        </div>

        <div className="actions">
          <button
            className={`action primary${busy === 'start' ? ' busy' : ''}`}
            onClick={startRecording}
            disabled={!canCapture || Boolean(recording) || Boolean(recordBlocked)}
          >
            <span className="dot" />
            {busy === 'start' ? 'Starting…' : 'Start Recording'}
          </button>

          <button
            className={`action stop${recording ? ' armed' : ''}${busy === 'stop' ? ' busy' : ''}`}
            onClick={stopRecording}
            disabled={!recording || busy === 'stop'}
          >
            <span className="square" />
            {busy === 'stop' ? 'Saving…' : 'Stop Recording'}
          </button>

          <button
            className={`action${busy === 'screenshot' ? ' busy' : ''}`}
            onClick={takeScreenshot}
            disabled={!canCapture || screenshotBlocked}
          >
            <CameraIcon />
            {busy === 'screenshot' ? 'Capturing…' : 'Take Screenshot'}
          </button>
        </div>

        <Status
          onCopy={copy}
          copied={copied}
          recording={recording}
          recordingDevice={recordingDevice}
          now={now}
          message={message}
          missingTool={missingTool}
          recordBlocked={recordBlocked}
          selected={selected}
          deviceCount={devices.length}
        />

        <div className="section">
          <div className="label">Save to</div>
          <div className="path-row">
            <button
              className="path"
              onClick={() => copy(settings.outputDir, 'folder')}
              disabled={!settings}
              title={settings ? `${settings.outputDir}\nClick to copy` : undefined}
            >
              {settings ? ltr(tildify(settings.outputDir, home)) : '…'}
            </button>
            {copied?.target === 'folder' && <span key={copied.at} className="copied">Copied</span>}
            <button className="small-button" onClick={chooseFolder}>Change…</button>
            <button
              className="small-button"
              onClick={() => window.api.openPath(settings.outputDir)}
              disabled={!settings}
            >
              Reveal
            </button>
          </div>
        </div>

        <div className="section">
          <div className="footer-row">
            <button className="disclosure" onClick={() => setShowOptions((v) => !v)}>
              {showOptions ? '▾ Options' : '▸ Options'}
            </button>
            {version && <span className="version" title={`ScreenSnap ${version}`}>v{version}</span>}
          </div>
          {showOptions && settings && (
            <div className="options">
              <div className="option-row">
                <span>Video format</span>
                <select
                  value={settings.videoFormat}
                  onChange={(e) => patchSettings({ videoFormat: e.target.value })}
                >
                  <option value="mov">QuickTime (.mov)</option>
                  <option value="mp4">MPEG-4 (.mp4)</option>
                </select>
              </div>
              <div className="option-row">
                <span>Android bitrate</span>
                <span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={settings.androidBitrateMbps}
                    onChange={(e) => patchSettings({ androidBitrateMbps: Number(e.target.value) || 8 })}
                  />{' '}
                  Mbps
                </span>
              </div>
              <div className="option-row">
                <span>iPhone/iPad bitrate</span>
                <span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={settings.iosBitrateMbps}
                    onChange={(e) => patchSettings({ iosBitrateMbps: Number(e.target.value) || 10 })}
                  />{' '}
                  Mbps
                </span>
              </div>
              <label className="option-row" style={{ cursor: 'pointer' }}>
                <span>Reveal each capture in Finder</span>
                <input
                  type="checkbox"
                  checked={settings.revealAfterCapture}
                  onChange={(e) => patchSettings({ revealAfterCapture: e.target.checked })}
                />
              </label>
              <label className="option-row" style={{ cursor: 'pointer' }}>
                <span>Show taps (Android &amp; iOS Simulator)</span>
                <input
                  type="checkbox"
                  checked={settings.showTouches}
                  onChange={(e) => patchSettings({ showTouches: e.target.checked })}
                />
              </label>
              <div className="hint">
                Screenshots are saved as .png. Recordings are padded to their real length and written at
                {' '}30 fps, because Android and the Simulator only emit frames when the screen changes.
                {settings.showTouches && (
                  <>
                    {' '}On the Simulator, taps are your clicks on its window and need Accessibility access
                    {' '}(asked on first recording). Physical iPhones and iPads can’t show taps.
                  </>
                )}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </>
  );
}

function Status({ recording, recordingDevice, now, message, missingTool, recordBlocked, selected, deviceCount, onCopy, copied }) {
  if (recording) {
    return (
      <div className="status recording">
        <span className="rec-dot" />
        <span className="elapsed">{formatElapsed(now - recording.startedAt)}</span>
        <span className="status-text">{recordingDevice?.name || 'Recording'}</span>
      </div>
    );
  }
  if (message?.kind === 'error') {
    return (
      <div className="status error">
        <span aria-hidden>⚠</span>
        <span className="status-text">{message.text}</span>
      </div>
    );
  }
  if (message?.kind === 'success') {
    return (
      <div className="status success">
        <span aria-hidden>✓</span>
        <button
          className="status-text copyable"
          title={`${message.path}\nClick to copy`}
          onClick={() => onCopy(message.path, 'capture')}
        >
          {message.text}
        </button>
        <span className="status-buttons">
          <button className="link" onClick={() => window.api.openPath(message.path)}>Open</button>
          <button className="link" onClick={() => window.api.revealInFinder(message.path)}>Show</button>
        </span>
        {copied?.target === 'capture' && <span key={copied.at} className="copied below">Copied</span>}
      </div>
    );
  }
  if (missingTool) {
    return (
      <div className="status error">
        <span aria-hidden>⚠</span>
        <span className="status-text">{missingTool}</span>
      </div>
    );
  }
  if (recordBlocked) {
    return (
      <div className="status warn">
        <span aria-hidden>⚠</span>
        <span className="status-text">{recordBlocked}</span>
      </div>
    );
  }
  if (selected && !selected.ready) {
    return (
      <div className="status">
        <span className="status-text">{selected.note || 'This device cannot be captured right now'}</span>
      </div>
    );
  }
  return (
    <div className="status">
      <span className="status-text">
        {deviceCount === 0 ? 'Looking for devices…' : selected ? 'Ready' : 'Select a device to begin'}
      </span>
    </div>
  );
}
