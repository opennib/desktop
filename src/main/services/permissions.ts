import type { Permissions, PermissionState } from "@opennib/core"

/**
 * The slice of Electron's `systemPreferences` we use. Defining it here keeps
 * the adapter testable without importing electron directly.
 */
export interface SystemPreferencesLike {
  getMediaAccessStatus?(mediaType: "microphone"): MediaAccessStatus
  askForMediaAccess?(mediaType: "microphone"): Promise<boolean>
  isTrustedAccessibilityClient?(prompt: boolean): boolean
}

export type MediaAccessStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown"

export interface ElectronPermissionsOptions {
  readonly platform: NodeJS.Platform
  readonly systemPreferences: SystemPreferencesLike
}

export class ElectronPermissions implements Permissions {
  private readonly platform: NodeJS.Platform
  private readonly systemPreferences: SystemPreferencesLike

  constructor(options: ElectronPermissionsOptions) {
    this.platform = options.platform
    this.systemPreferences = options.systemPreferences
    if (this.platform === "darwin") {
      this.accessibility = this.macAccessibility
      this.requestAccessibility = this.macRequestAccessibility
    }
  }

  accessibility?: () => Promise<PermissionState>
  requestAccessibility?: () => Promise<PermissionState>

  async microphone(): Promise<PermissionState> {
    const get = this.systemPreferences.getMediaAccessStatus
    if (this.platform !== "darwin" || get === undefined) {
      return "undetermined"
    }
    return mapMediaStatus(get.call(this.systemPreferences, "microphone"))
  }

  async requestMicrophone(): Promise<PermissionState> {
    const ask = this.systemPreferences.askForMediaAccess
    if (this.platform !== "darwin" || ask === undefined) {
      return this.microphone()
    }
    const granted = await ask.call(this.systemPreferences, "microphone")
    return granted ? "granted" : "denied"
  }

  private macAccessibility = async (): Promise<PermissionState> => {
    const check = this.systemPreferences.isTrustedAccessibilityClient
    if (check === undefined) return "undetermined"
    return check.call(this.systemPreferences, false) ? "granted" : "denied"
  }

  private macRequestAccessibility = async (): Promise<PermissionState> => {
    const check = this.systemPreferences.isTrustedAccessibilityClient
    if (check === undefined) return "undetermined"
    return check.call(this.systemPreferences, true) ? "granted" : "denied"
  }
}

function mapMediaStatus(status: MediaAccessStatus): PermissionState {
  switch (status) {
    case "granted":
      return "granted"
    case "denied":
    case "restricted":
      return "denied"
    case "not-determined":
    case "unknown":
    default:
      return "undetermined"
  }
}
