// Streams the Mac pointer's presses over one Simulator window as JSON lines, so
// capture.cjs can draw tap circles into a simctl recording (which never shows them).
//
//   touches <window title prefix>
//   -> {"t":<epoch ms>,"type":"down"|"drag"|"up","x":0..1,"y":0..1}
//
// x/y are relative to the simulated screen, which Simulator exposes to
// Accessibility as the window's AXGroup. Presses outside it are ignored.
// Needs Accessibility permission; prints {"error":"accessibility"} without it.
import AppKit
import ApplicationServices

setvbuf(stdout, nil, _IOLBF, 0)
let titlePrefix = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
    print(line)
  }
}

guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) else {
  emit(["error": "accessibility"])
  exit(2)
}

func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value as? T
}

func frame(_ element: AXUIElement) -> CGRect? {
  guard let p: AXValue = attribute(element, kAXPositionAttribute), let s: AXValue = attribute(element, kAXSizeAttribute) else { return nil }
  var origin = CGPoint.zero, size = CGSize.zero
  AXValueGetValue(p, .cgPoint, &origin)
  AXValueGetValue(s, .cgSize, &size)
  return CGRect(origin: origin, size: size)
}

/// The simulated screen of our device's window, in top-left-origin screen points.
func screenFrame() -> CGRect? {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator").first else { return nil }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  let windows: [AXUIElement] = attribute(axApp, kAXWindowsAttribute) ?? []
  for window in windows {
    let title: String = attribute(window, kAXTitleAttribute) ?? ""
    guard title.hasPrefix(titlePrefix) else { continue }
    let children: [AXUIElement] = attribute(window, kAXChildrenAttribute) ?? []
    let groups = children.filter { (attribute($0, kAXRoleAttribute) as String?) == kAXGroupRole }.compactMap(frame)
    return groups.max { $0.width * $0.height < $1.width * $1.height }
  }
  return nil
}

/// Whether the press actually hit a Simulator window, not something covering it.
/// (NSWorkspace's frontmost app lags behind the click that activates Simulator.)
func isSimulatorOnTop(at point: CGPoint) -> Bool {
  var element: AXUIElement?
  guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success,
        let element else { return false }
  var pid: pid_t = 0
  AXUIElementGetPid(element, &pid)
  return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.apple.iphonesimulator"
}

var pressed: CGRect? = nil  // the screen frame captured when the press began

func handle(_ event: NSEvent) {
  // NSEvent reports bottom-left-origin coordinates; Accessibility uses top-left.
  let loc = NSEvent.mouseLocation
  let point = CGPoint(x: loc.x, y: (NSScreen.screens.first?.frame.height ?? 0) - loc.y)
  let t = Date().timeIntervalSince1970 * 1000

  switch event.type {
  case .leftMouseDown:
    guard isSimulatorOnTop(at: point), let rect = screenFrame(), rect.contains(point) else { return }
    pressed = rect
    fallthrough
  case .leftMouseDragged, .leftMouseUp:
    guard let rect = pressed else { return }
    let type = event.type == .leftMouseDown ? "down" : event.type == .leftMouseUp ? "up" : "drag"
    emit([
      "t": t, "type": type,
      "x": min(max((point.x - rect.minX) / rect.width, 0), 1),
      "y": min(max((point.y - rect.minY) / rect.height, 0), 1),
    ])
    if event.type == .leftMouseUp { pressed = nil }
  default:
    break
  }
}

NSApplication.shared.setActivationPolicy(.prohibited)
_ = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp], handler: handle)
emit(["ready": true])
// Exit with the parent: stdin closes when capture.cjs goes away.
FileHandle.standardInput.readabilityHandler = { if $0.availableData.isEmpty { exit(0) } }
NSApplication.shared.run()
