import Cocoa
import IOKit.hid

// Push-to-talk on macOS needs both keydown and keyup. Apple's Fn key is not
// exposed through Electron's globalShortcut, JS keyboard listeners, or the
// standard CGEvent pipeline, and the other keys we offer are modifiers, which
// also arrive as .flagsChanged rather than keyDown/keyUp. One global monitor
// on .flagsChanged covers all of them, so this helper watches whichever key
// it is told to:
//
//   fn-key-monitor [Fn | LeftCtrl | RightAlt | RightCmd]     (default: Fn)
//
// The binary keeps its historical name so existing Input Monitoring grants
// stay attached to it.
//
// Build:
//   swiftc native/fn-key-monitor.swift -o native/fn-key-monitor -O
//
// Output protocol (one event per line, flushed):
//   WAITING_PERMISSION  macOS has not granted keyboard access yet (see below)
//   READY               once the global monitor is installed
//   DOWN                Fn pressed
//   UP                  Fn released
//
// MacFnHotkey (src/main/services/hotkey.ts) spawns this binary and parses
// stdout. Killing the process detaches the monitor.
//
// Permission: a global key monitor needs Input Monitoring (or Accessibility)
// for THIS process — it is its own client to macOS until the app is signed
// with a Developer ID. macOS evaluates the grant when the monitor is
// installed, so a monitor installed before the grant stays deaf until the
// process restarts (that is the "Quit & Reopen" macOS shows). We therefore
// ask first, and install the monitor only once access is granted, polling
// once a second while the user flips the toggle. No app relaunch needed.

enum WatchedKey {
  case fn
  case modifier(flag: NSEvent.ModifierFlags, keyCode: UInt16)

  static func parse(_ name: String?) -> WatchedKey? {
    switch name ?? "Fn" {
    case "Fn": return .fn
    // Virtual key codes from Carbon's Events.h.
    case "LeftCtrl": return .modifier(flag: .control, keyCode: 59)
    case "RightAlt": return .modifier(flag: .option, keyCode: 61)
    case "RightCmd": return .modifier(flag: .command, keyCode: 54)
    default: return nil
    }
  }
}

guard let watched = WatchedKey.parse(CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil) else {
  FileHandle.standardError.write(
    "fn-key-monitor: unsupported key \(CommandLine.arguments[1]); expected Fn, LeftCtrl, RightAlt or RightCmd\n"
      .data(using: .utf8) ?? Data())
  exit(2)
}

func hasKeyboardAccess() -> Bool {
  return IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
    || AXIsProcessTrusted()
}

class FnKeyMonitor: NSObject, NSApplicationDelegate {
  let watched: WatchedKey
  var keyDown = false

  init(watched: WatchedKey) {
    self.watched = watched
    super.init()
  }

  func report(down: Bool) {
    if down == keyDown { return }
    keyDown = down
    print(down ? "DOWN" : "UP")
    fflush(stdout)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    if hasKeyboardAccess() {
      installMonitor()
      return
    }
    // Triggers the system prompt (once per process) and lists this helper in
    // System Settings → Privacy & Security → Input Monitoring.
    _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    print("WAITING_PERMISSION")
    fflush(stdout)
    Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
      guard let self = self else { return }
      if hasKeyboardAccess() {
        timer.invalidate()
        self.installMonitor()
      }
    }
  }

  func installMonitor() {
    NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      guard let self = self else { return }
      switch self.watched {
      case .fn:
        // Fn has no reliable key code in flagsChanged; track the flag itself.
        self.report(down: event.modifierFlags.contains(.function))
      case .modifier(let flag, let keyCode):
        // Only this physical key's transitions. The flag alone is not enough:
        // the left and right keys of a modifier share it.
        guard event.keyCode == keyCode else { return }
        let flagSet = event.modifierFlags.contains(flag)
        // If the flag is still set on a key-code event while we are already
        // down, the sibling key is held and this one was released.
        self.report(down: flagSet && !self.keyDown)
      }
    }

    print("READY")
    fflush(stdout)
  }
}

let app = NSApplication.shared
let delegate = FnKeyMonitor(watched: watched)
app.delegate = delegate
app.setActivationPolicy(.prohibited)
app.run()
