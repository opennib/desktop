import Cocoa

// Push-to-talk on macOS needs both keydown and keyup, but Apple's Fn key is
// not exposed through Electron's globalShortcut, JS keyboard listeners, or
// the standard CGEvent pipeline. NSEvent.addGlobalMonitorForEvents(.flagsChanged)
// sees the modifier change and lets us bracket the press.
//
// Build:
//   swiftc native/fn-key-monitor.swift -o resources/fn-key-monitor -O
//
// Output protocol (one event per line, flushed):
//   READY     once at startup, after the global monitor is installed
//   DOWN      Fn pressed
//   UP        Fn released
//
// MacFnHotkey (src/main/services/hotkey.ts) spawns this binary and parses
// stdout. Killing the process detaches the monitor.

class FnKeyMonitor: NSObject, NSApplicationDelegate {
  var fnDown = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      guard let self = self else { return }
      let isFn = event.modifierFlags.contains(.function)

      if isFn && !self.fnDown {
        self.fnDown = true
        print("DOWN")
        fflush(stdout)
      } else if !isFn && self.fnDown {
        self.fnDown = false
        print("UP")
        fflush(stdout)
      }
    }

    print("READY")
    fflush(stdout)
  }
}

let app = NSApplication.shared
let delegate = FnKeyMonitor()
app.delegate = delegate
app.setActivationPolicy(.prohibited)
app.run()
