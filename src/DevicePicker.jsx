import { useEffect, useRef, useState } from 'react';

/** Simplified Android robot head — no eyes, so it stays legible at 14px. */
function AndroidIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7.9 5.9 6.6 3.7a.5.5 0 0 1 .87-.5l1.3 2.26A8 8 0 0 1 12 4.9c1.15 0 2.24.2 3.23.56l1.3-2.26a.5.5 0 1 1 .87.5L16.1 5.9a6.6 6.6 0 0 1 3.4 5.2h-15a6.6 6.6 0 0 1 3.4-5.2Z" />
      <rect x="4.5" y="12.4" width="15" height="7.4" rx="2.4" />
      <rect x="1.4" y="12.4" width="2.3" height="6.4" rx="1.15" />
      <rect x="20.3" y="12.4" width="2.3" height="6.4" rx="1.15" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M16.36 1.43c0 1.14-.42 2.2-1.12 3.01-.85.99-2.24 1.76-3.4 1.66a3.5 3.5 0 0 1-.03-.42c0-1.09.5-2.24 1.24-3.02.8-.86 2.16-1.5 3.28-1.55.02.11.03.22.03.32Zm4.34 15.67c-.55 1.27-.82 1.84-1.53 2.96-.99 1.56-2.38 3.5-4.1 3.52-1.53.01-1.93-1-4-.99-2.08.01-2.51 1.01-4.04 1-1.72-.02-3.04-1.77-4.03-3.33-2.76-4.36-3.05-9.47-1.34-12.19C2.88 6.14 4.8 5.01 6.61 5.01c1.84 0 3 1.01 4.52 1.01 1.48 0 2.38-1.01 4.51-1.01 1.61 0 3.32.88 4.54 2.4-3.99 2.19-3.34 7.88.52 9.69Z" />
    </svg>
  );
}

function DeviceIcon({ platform }) {
  return (
    <span className={`glyph ${platform}`}>{platform === 'android' ? <AndroidIcon /> : <AppleIcon />}</span>
  );
}

const KIND_LABEL = { device: 'Device', emulator: 'Emulator', simulator: 'Simulator' };

function describe(device) {
  const parts = [device.osVersion, KIND_LABEL[device.kind]].filter(Boolean);
  if (device.ready && device.canRecord === false) parts.push('screenshots only');
  if (device.kind !== 'simulator' && device.serial) parts.push(device.serial);
  return parts.join(' · ');
}

const GROUPS = [
  { key: 'android', title: 'Android', match: (d) => d.platform === 'android' },
  { key: 'ios-device', title: 'iPhone & iPad', match: (d) => d.platform === 'ios' && d.kind === 'device' },
  { key: 'ios-sim', title: 'iOS Simulators', match: (d) => d.kind === 'simulator' },
];

export default function DevicePicker({
  devices,
  selectedId,
  onSelect,
  onRefresh,
  showOffline,
  onToggleOffline,
  recordingId,
}) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const rootRef = useRef(null);

  const selected = devices.find((d) => d.id === selectedId) || null;

  // Hide the long tail of shut-down simulators unless asked for, but never hide
  // whatever is currently selected or recording.
  const visible = devices.filter(
    (d) => showOffline || d.ready || d.id === selectedId || d.id === recordingId,
  );

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="picker" ref={rootRef}>
      <button className="picker-button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {selected ? (
          <>
            <DeviceIcon platform={selected.platform} />
            <span className="device-text">
              <div className="device-name">{selected.name}</div>
              <div className="device-meta">{describe(selected)}</div>
            </span>
          </>
        ) : (
          <>
            <span className="glyph">?</span>
            <span className="device-text">
              <div className="device-name">No device selected</div>
              <div className="device-meta">
                {devices.length ? 'Choose one from the list' : 'Nothing connected yet'}
              </div>
            </span>
          </>
        )}
        <span className="picker-caret">▾</span>
      </button>

      {open && (
        <div className="popover" role="listbox">
          {visible.length === 0 && (
            <div className="popover-empty">
              No devices found.
              <div className="hint" style={{ marginTop: 6 }}>
                Plug in a device with USB debugging on, or boot an emulator or simulator.
              </div>
            </div>
          )}

          {GROUPS.map((group) => {
            const entries = visible.filter(group.match);
            if (entries.length === 0) return null;
            return (
              <div key={group.key}>
                <div className="popover-group">{group.title}</div>
                {entries.map((device) => (
                  <button
                    key={device.id}
                    role="option"
                    aria-selected={device.id === selectedId}
                    className={`option${device.id === selectedId ? ' selected' : ''}`}
                    disabled={!device.ready}
                    title={device.note || device.serial}
                    onClick={() => {
                      onSelect(device.id);
                      setOpen(false);
                    }}
                  >
                    <DeviceIcon platform={device.platform} />
                    <span className="device-text" style={{ flex: 1 }}>
                      <div className="device-name">{device.name}</div>
                      <div className="device-meta">{device.note || describe(device)}</div>
                    </span>
                    {device.id === recordingId && <span className="rec-dot" />}
                  </button>
                ))}
              </div>
            );
          })}

          <div className="popover-footer">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showOffline}
                onChange={(e) => onToggleOffline(e.target.checked)}
              />
              Show offline
            </label>
            <button className="link" onClick={refresh} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : '⟳ Refresh'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
