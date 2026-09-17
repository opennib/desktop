import type { Storage } from "@opennib/core"

export interface UserDataPathProvider {
  getPath(name: "userData"): string
}

/**
 * Storage on desktop just exposes the per-user app data directory. We force
 * forward slashes so core code (which avoids node:path) can do plain string
 * concatenation regardless of platform.
 */
export class ElectronStorage implements Storage {
  constructor(private readonly app: UserDataPathProvider) {}

  baseDirectory(): string {
    return normalize(this.app.getPath("userData"))
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/")
}
