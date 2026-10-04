/**
 * Renderer-side platform flags. The main process is not reachable
 * synchronously from here, and `navigator.platform` is enough to pick copy
 * and flows ("Win32", "MacIntel", "Linux x86_64").
 */
const platform = navigator.platform.toLowerCase()
export const IS_MAC = platform.includes("mac")
export const IS_WIN = platform.includes("win")

export interface MicProbeResult {
  readonly state: "granted" | "denied"
  /** Status label when the probe failed for a reason other than a plain denial. */
  readonly label: string | null
}

/**
 * Open the default microphone once and release it. On Windows and Linux this
 * is the only way to ask for access: there is no native prompt the main
 * process can call, and the OS answers through getUserMedia (Windows throws
 * NotAllowedError when its microphone privacy switch blocks desktop apps).
 */
export async function probeMicrophone(): Promise<MicProbeResult> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
    return { state: "granted", label: null }
  } catch (err) {
    const name = err instanceof Error ? err.name : ""
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return { state: "denied", label: "No microphone found" }
    }
    return { state: "denied", label: "Microphone blocked by the system" }
  }
}
