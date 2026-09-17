import { describe, expect, it, vi } from "vitest"

import {
  ElectronPermissions,
  type MediaAccessStatus,
  type SystemPreferencesLike,
} from "../../../src/main/services/permissions"

function macSystemPreferences(overrides: Partial<SystemPreferencesLike> = {}): SystemPreferencesLike {
  return {
    getMediaAccessStatus: () => "granted" as MediaAccessStatus,
    askForMediaAccess: async () => true,
    isTrustedAccessibilityClient: () => true,
    ...overrides,
  }
}

describe("ElectronPermissions on macOS", () => {
  it("maps microphone statuses to PermissionState", async () => {
    const cases: Array<[MediaAccessStatus, "granted" | "denied" | "undetermined"]> = [
      ["granted", "granted"],
      ["denied", "denied"],
      ["restricted", "denied"],
      ["not-determined", "undetermined"],
      ["unknown", "undetermined"],
    ]
    for (const [status, expected] of cases) {
      const p = new ElectronPermissions({
        platform: "darwin",
        systemPreferences: macSystemPreferences({ getMediaAccessStatus: () => status }),
      })
      expect(await p.microphone()).toBe(expected)
    }
  })

  it("requestMicrophone returns granted when the OS prompt is accepted", async () => {
    const ask = vi.fn(async () => true)
    const p = new ElectronPermissions({
      platform: "darwin",
      systemPreferences: macSystemPreferences({ askForMediaAccess: ask }),
    })
    expect(await p.requestMicrophone()).toBe("granted")
    expect(ask).toHaveBeenCalledWith("microphone")
  })

  it("requestMicrophone returns denied when the prompt is rejected", async () => {
    const p = new ElectronPermissions({
      platform: "darwin",
      systemPreferences: macSystemPreferences({ askForMediaAccess: async () => false }),
    })
    expect(await p.requestMicrophone()).toBe("denied")
  })

  it("exposes accessibility methods only on darwin", () => {
    const mac = new ElectronPermissions({
      platform: "darwin",
      systemPreferences: macSystemPreferences(),
    })
    expect(typeof mac.accessibility).toBe("function")
    expect(typeof mac.requestAccessibility).toBe("function")

    const linux = new ElectronPermissions({
      platform: "linux",
      systemPreferences: {},
    })
    expect(linux.accessibility).toBeUndefined()
    expect(linux.requestAccessibility).toBeUndefined()
  })

  it("accessibility queries without prompt; requestAccessibility prompts", async () => {
    const check = vi.fn((_prompt: boolean) => true)
    const p = new ElectronPermissions({
      platform: "darwin",
      systemPreferences: macSystemPreferences({ isTrustedAccessibilityClient: check }),
    })

    expect(await p.accessibility?.()).toBe("granted")
    expect(check).toHaveBeenLastCalledWith(false)

    expect(await p.requestAccessibility?.()).toBe("granted")
    expect(check).toHaveBeenLastCalledWith(true)
  })

  it("accessibility returns denied when not trusted", async () => {
    const p = new ElectronPermissions({
      platform: "darwin",
      systemPreferences: macSystemPreferences({ isTrustedAccessibilityClient: () => false }),
    })
    expect(await p.accessibility?.()).toBe("denied")
  })
})

describe("ElectronPermissions on non-darwin", () => {
  it("microphone is undetermined on platforms without systemPreferences support", async () => {
    const p = new ElectronPermissions({ platform: "linux", systemPreferences: {} })
    expect(await p.microphone()).toBe("undetermined")
  })

  it("requestMicrophone falls back to microphone() when ask is unavailable", async () => {
    const p = new ElectronPermissions({ platform: "win32", systemPreferences: {} })
    expect(await p.requestMicrophone()).toBe("undetermined")
  })
})
