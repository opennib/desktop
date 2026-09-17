import Cocoa

// Posts a Cmd+V keystroke via CGEvent. We use this instead of nut-js or
// AppleScript because:
//   - nut-js has Apple Silicon stability issues for repeated keystrokes
//   - AppleScript needs Automation permission, which is annoying to grant
//   - CGEvent posts work as long as the app has Accessibility permission
//
// Build:
//   swiftc -O native/paste-helper.swift -o native/paste-helper
//   codesign --force --sign - native/paste-helper
//
// The explicit ad-hoc codesign is REQUIRED on macOS: without it, swiftc
// emits a `linker-signed` adhoc signature that the Accessibility framework
// treats as ephemeral, so a granted toggle in System Settings won't
// persist across rebuilds.
//
// Three details that aren't optional, learned from OpenWhispr's
// macos-fast-paste after our naive POC port silently no-op'd on recent
// macOS:
//   1. `cgSessionEventTap` (window-server-routed) instead of
//      `cghidEventTap` (hardware-emulation). Recent macOS aggressively
//      filters HID-tap events from non-Apple processes; session-tap
//      events are dispatched on the same path real keystrokes take.
//   2. 8ms delay between keyDown and keyUp. Some apps debounce
//      "instant" press-release pairs and ignore them.
//   3. 20ms trailing delay before exit. CGEvent.post is asynchronous —
//      it hands the event to the window server and returns. If the
//      process exits immediately, the event source goes away and
//      macOS drops the event before delivery.
//
// Permission: this binary is its own Accessibility client. Until the app is
// Developer-ID signed, macOS does not attribute it to the opennib bundle, so
// the app's own grant does not cover it and a Cmd+V posted without trust is
// silently dropped. Ask explicitly: `kAXTrustedCheckOptionPrompt` makes
// macOS show the permission dialog and list the helper in System Settings →
// Privacy & Security → Accessibility the first time. Exit code 2 tells the
// caller this was a permission failure, not a broken helper.

let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as NSString
let trusted = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
if !trusted {
  FileHandle.standardError.write(
    "paste-helper: Accessibility permission not granted\n".data(using: .utf8) ?? Data())
  exit(2)
}

guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: true),
      let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: false) else {
  FileHandle.standardError.write("paste-helper: failed to create CGEvent\n".data(using: .utf8) ?? Data())
  exit(1)
}

keyDown.flags = .maskCommand
keyUp.flags = .maskCommand
keyDown.post(tap: .cgSessionEventTap)
usleep(8000)
keyUp.post(tap: .cgSessionEventTap)
usleep(20000)
