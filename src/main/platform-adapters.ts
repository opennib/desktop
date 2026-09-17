import { execFile, spawn } from "node:child_process"
import { join } from "node:path"

import { app, clipboard } from "electron"

import { log, type Hotkey, type Paster } from "@opennib/core"
import { GlobalKeyboardListener } from "node-global-key-listener"

import { GlobalKeyListenerHotkey } from "./services/global-key-hotkey"
import { MacFnHotkey } from "./services/hotkey"
import { MacPaster } from "./services/paster"
import { SystemPaster } from "./services/system-paster"

export function createPaster(): Paster {
  if (process.platform === "darwin") {
    return new MacPaster({
      clipboard,
      pasteHelperPath: nativeBinaryPath("OPENNIB_PASTE_HELPER_PATH", "paste-helper"),
      exec: async (path: string) => {
        // Direct spawn (no shell). Routing through `/bin/sh -c` adds a shell
        // ancestor that confuses macOS responsible-process attribution for
        // Accessibility checks; the qvac-dictate POC uses execFile too.
        await new Promise<void>((resolve, reject) => {
          execFile(path, [], { timeout: 2000 }, (err, _stdout, stderr) => {
            if (err) {
              const errOut = stderr?.toString().trim() ?? ""
              if (errOut.length > 0) log.warn("paste-helper stderr", { stderr: errOut })
              reject(err)
              return
            }
            resolve()
          })
        })
      },
    })
  }

  // Windows + Linux: write to the system clipboard, then synthesize Ctrl+V via
  // a platform-native tool. PowerShell SendKeys on Windows; xdotool (X11) or
  // wtype (Wayland) on Linux. The Linux helpers are a soft requirement —
  // packagers should call them out in install docs.
  return new SystemPaster({
    clipboard,
    spawnPaste: () =>
      new Promise<void>((resolve, reject) => {
        const command = pasteCommand()
        execFile(command.bin, command.args, { timeout: 2000 }, (err, _stdout, stderr) => {
          if (err) {
            const errOut = stderr?.toString().trim() ?? ""
            if (errOut.length > 0) log.warn(`${command.bin} stderr`, { stderr: errOut })
            reject(err)
            return
          }
          resolve()
        })
      }),
  })
}

/**
 * Build the Hotkey adapter that knows how to register `combo`. macOS's Fn key
 * is invisible to JS-level key hooks, so "Fn" must route to the native Swift
 * helper; every other combo goes through `node-global-key-listener` (which
 * works on macOS, Windows, and Linux). Picking the right adapter at creation
 * time lets the host swap hotkeys at runtime by tearing down the old adapter
 * and asking for a fresh one with the new combo.
 */
export function createHotkey(combo: string): Hotkey {
  if (combo === "Fn") {
    if (process.platform !== "darwin") {
      throw new Error("Fn hotkey is only available on macOS")
    }
    return new MacFnHotkey({
      binaryPath: nativeBinaryPath("OPENNIB_FN_MONITOR_PATH", "fn-key-monitor"),
      spawn,
    })
  }
  return new GlobalKeyListenerHotkey({
    factory: () => new GlobalKeyboardListener(),
  })
}

/**
 * Platform-default hotkey combo. macOS uses Fn (because every Apple Silicon
 * keyboard has one and it's never bound to something else system-wide);
 * Windows/Linux default to RightAlt — single key, easy to hold, rare in
 * shortcut maps.
 */
export function defaultHotkeyForPlatform(): string {
  return process.platform === "darwin" ? "Fn" : "RightAlt"
}

function pasteCommand(): { bin: string; args: readonly string[] } {
  if (process.platform === "win32") {
    return {
      bin: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('^v')",
      ],
    }
  }
  // Linux: prefer wtype on Wayland (xdotool doesn't work there); fall back to
  // xdotool on X11. Detect via WAYLAND_DISPLAY, which Wayland compositors set
  // on session start.
  if (process.env["WAYLAND_DISPLAY"] !== undefined && process.env["WAYLAND_DISPLAY"].length > 0) {
    return { bin: "wtype", args: ["-M", "ctrl", "v", "-m", "ctrl"] }
  }
  return { bin: "xdotool", args: ["key", "ctrl+v"] }
}

function nativeBinaryPath(envVar: string, name: string): string {
  const fromEnv = process.env[envVar]
  if (fromEnv && fromEnv.length > 0) return fromEnv
  // In a packaged build the asar archive doesn't contain extras — they're
  // unpacked under `process.resourcesPath`. In dev, `app.getAppPath()` is
  // the package directory and the binaries sit at `native/<name>` next to
  // package.json. `app.isPackaged` distinguishes the two reliably.
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, "native", name)
}
