import { execFile, spawn } from "node:child_process"
import { join } from "node:path"

import { app, clipboard } from "electron"

import { log, type Hotkey, type Paster } from "@opennib/core"
import { GlobalKeyboardListener } from "node-global-key-listener"

import { GlobalKeyListenerHotkey } from "./services/global-key-hotkey"
import {
  MAC_HELPER_COMBOS,
  MacFnHotkey,
  WIN_HELPER_COMBOS,
  WindowsKeyHotkey,
  type KeyboardAccessState,
  type SpawnLike,
} from "./services/hotkey"
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
        // Accessibility checks.
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
        // `windowsHide` keeps the PowerShell window from flashing on every paste.
        execFile(
          command.bin,
          command.args,
          { timeout: 4000, windowsHide: true },
          (err, _stdout, stderr) => {
            if (err) {
              const errOut = stderr?.toString().trim() ?? ""
              if (errOut.length > 0) log.warn(`${command.bin} stderr`, { stderr: errOut })
              reject(err)
              return
            }
            resolve()
          },
        )
      }),
  })
}

/**
 * Build the Hotkey adapter that knows how to register `combo`. On macOS every
 * offered preset (Fn, Left Control, Right Option, Right Command) goes through
 * the native Swift helper: Fn is invisible to JS-level key hooks, and using
 * one signed helper for all of them means one Input Monitoring grant and no
 * third-party binary. Windows and Linux, and any legacy macOS combo not on
 * that list, go through `node-global-key-listener`. Picking the adapter at
 * creation time lets the host swap hotkeys at runtime by tearing down the old
 * adapter and asking for a fresh one with the new combo.
 */
export interface CreateHotkeyOptions {
  /** Keyboard-access reports from adapters that can tell (the Fn helper). */
  readonly onKeyboardAccess?: (state: KeyboardAccessState) => void
}

export function createHotkey(combo: string, options: CreateHotkeyOptions = {}): Hotkey {
  if (combo === "Fn" && process.platform !== "darwin") {
    throw new Error("Fn hotkey is only available on macOS")
  }
  if (process.platform === "darwin" && MAC_HELPER_COMBOS.includes(combo)) {
    return new MacFnHotkey({
      binaryPath: nativeBinaryPath("OPENNIB_FN_MONITOR_PATH", "fn-key-monitor"),
      spawn,
      ...(options.onKeyboardAccess !== undefined
        ? { onKeyboardAccess: options.onKeyboardAccess }
        : {}),
    })
  }
  if (process.platform === "win32" && WIN_HELPER_COMBOS.includes(combo)) {
    // No console window for the watcher; see WindowsKeyHotkey for why this is
    // a script rather than node-global-key-listener's hook binary.
    const spawnHidden: SpawnLike = (path, args) =>
      spawn(path, [...(args ?? [])], { windowsHide: true })
    return new WindowsKeyHotkey({
      scriptPath: nativeBinaryPath("OPENNIB_WIN_KEY_MONITOR_PATH", "win-key-monitor.ps1"),
      spawn: spawnHidden,
      parentPid: process.pid,
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
      bin: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
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
