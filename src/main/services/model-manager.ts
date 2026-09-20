import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  ModelLoadError,
  NotFoundError,
  getLlmModel,
  getWhisperModel,
  isLlmModelId,
  isWhisperModelId,
  log,
  type ModelManager,
} from "@opennib/core"

/**
 * A downloadable model file. Whisper and LLM entries already have this
 * shape, so we don't define a fresh adapter type — `getWhisperModel` /
 * `getLlmModel` return values that satisfy this contract directly.
 *
 * `sha256`, when set, is verified after every download and is rechecked
 * lazily for pre-existing files whose sentinel doesn't already contain the
 * expected hash. Entries without `sha256` (currently LLM) fall back to the
 * legacy "sentinel-presence" trust model.
 */
export interface DownloadableEntry {
  readonly file: string
  readonly downloadUrl: string
  readonly sha256?: string
}

/**
 * Plug-in description for one *kind* of model the manager handles. Each
 * kind owns a subdirectory under `baseDir` and a resolver that knows
 * which ids it recognizes.
 */
export interface ModelKind {
  readonly subdir: string
  resolve(id: string): DownloadableEntry | undefined
}

export const WHISPER_MODEL_KIND: ModelKind = {
  subdir: "whisper",
  resolve: (id) => (isWhisperModelId(id) ? getWhisperModel(id) : undefined),
}

export const LLM_MODEL_KIND: ModelKind = {
  subdir: "llm",
  resolve: (id) => (isLlmModelId(id) ? getLlmModel(id) : undefined),
}

export interface FsModelManagerOptions {
  readonly baseDir: string
  /**
   * Model kinds this manager handles. Defaults to Whisper only so existing
   * call sites and tests that only care about Whisper need no changes.
   */
  readonly kinds?: readonly ModelKind[]
  readonly fetchImpl?: typeof fetch
}

interface ResolvedModel {
  readonly entry: DownloadableEntry
  readonly kind: ModelKind
}

export class FsModelManager implements ModelManager {
  private readonly baseDir: string
  private readonly kinds: readonly ModelKind[]
  private readonly fetchImpl: typeof fetch

  constructor(options: FsModelManagerOptions) {
    this.baseDir = options.baseDir
    this.kinds = options.kinds ?? [WHISPER_MODEL_KIND]
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async pathFor(modelId: string): Promise<string> {
    const resolved = this.resolve(modelId)
    return this.targetPath(resolved)
  }

  /**
   * Reports installed only when the model file is present AND its `.complete`
   * sentinel proves it matches the registry's expected SHA256.
   *
   * Sentinel content is the verified SHA256 of the file. Three cases:
   *
   *   - Sentinel contains expected hash → installed (no rehash).
   *   - Sentinel missing or empty (legacy) or contains a stale/wrong hash →
   *     rehash file once; if it matches expected, rewrite sentinel and
   *     return true; otherwise unlink file + sentinel and return false so
   *     the model gets re-downloaded.
   *   - Entry has no `sha256` (LLM, today) → fall back to the legacy
   *     "sentinel present ⇒ installed" trust model and auto-stamp.
   *
   * The rehash cost is paid at most once per pre-existing file (the new
   * sentinel sticks after first verify), and never for fresh downloads
   * (download() writes the hash into the sentinel directly).
   */
  async isInstalled(modelId: string): Promise<boolean> {
    const resolved = this.resolve(modelId)
    const path = this.targetPath(resolved)
    const expected = resolved.entry.sha256
    let fileOk: boolean
    try {
      const s = await stat(path)
      fileOk = s.isFile() && s.size > 0
    } catch {
      return false
    }
    if (!fileOk) return false

    const sentinel = sentinelPath(path)
    if (expected === undefined) {
      // Legacy path for entries that haven't grown a canonical hash yet
      // (LLM models). Preserve the prior "sentinel presence" behavior.
      try {
        await stat(sentinel)
        return true
      } catch {
        try {
          await writeFile(sentinel, "")
          return true
        } catch {
          return false
        }
      }
    }

    let recorded = ""
    try {
      recorded = (await readFile(sentinel, "utf8")).trim()
    } catch {
      recorded = ""
    }
    if (recorded === expected) return true

    // Sentinel is empty (legacy), missing, or doesn't match the expected
    // hash. Rehash on the spot. This catches the failure mode we hit in
    // practice: byte-size-correct but content-wrong downloads that left a
    // valid-looking sentinel and a corrupt file (FAILED_TO_ACTIVATE: vector
    // in the whispercpp addon).
    const actual = await hashFile(path)
    if (actual === expected) {
      try {
        await writeFile(sentinel, expected)
      } catch (cause) {
        log.warn("model sentinel write failed; verification will rerun next boot", {
          modelId,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      }
      return true
    }

    log.warn("model checksum mismatch; deleting for re-download", {
      modelId,
      expected,
      actual,
      path,
    })
    await this.cleanupBadInstall(path, sentinel)
    return false
  }

  async download(modelId: string, onProgress?: (percent: number) => void): Promise<void> {
    const resolved = this.resolve(modelId)
    const target = this.targetPath(resolved)
    const partial = `${target}.partial`

    await mkdir(dirname(target), { recursive: true })

    let response: Response
    try {
      response = await this.fetchImpl(resolved.entry.downloadUrl)
    } catch (cause) {
      throw new ModelLoadError(`failed to start download for ${modelId}`, cause)
    }

    if (!response.ok || response.body === null) {
      throw new ModelLoadError(
        `unexpected response for ${modelId}: ${response.status} ${response.statusText}`,
      )
    }

    const totalHeader = response.headers.get("content-length")
    const total = totalHeader !== null ? Number(totalHeader) : 0
    let received = 0
    let lastReportedPercent = -1

    // Manually iterate the web stream and write/hash each chunk inline.
    // Every chunk is copied into a fresh Buffer because the Uint8Array
    // returned by `reader.read()` may alias a pooled / reused ArrayBuffer
    // (undici and Node's Buffer pool both recycle backing memory). Without
    // the copy, `hasher.update(chunk)` runs synchronously against the
    // current bytes, then `await handle.write(chunk)` schedules a libuv
    // worker write that reads the same memory later — by which point the
    // chunk's backing region may have been overwritten by a subsequent
    // read. The streaming hash still matches `expected` (because it saw
    // the right bytes at the right moment), the rename succeeds, then
    // `isInstalled()` rehashes the on-disk file and discovers a fresh
    // mismatch on every boot — the "different SHA256 every download"
    // failure we hit in production.
    const expected = resolved.entry.sha256
    const hasher = createHash("sha256")
    const handle = await open(partial, "w")
    try {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        const chunk = Buffer.from(value)
        hasher.update(chunk)
        await handle.write(chunk)
        received += chunk.length
        if (onProgress !== undefined && total > 0) {
          const percent = Math.floor((received / total) * 100)
          if (percent !== lastReportedPercent) {
            lastReportedPercent = percent
            onProgress(percent)
          }
        }
      }
    } catch (cause) {
      await handle.close().catch(() => {})
      await this.cleanupPartial(partial)
      throw new ModelLoadError(`failed to write ${modelId}`, cause)
    }
    await handle.close()

    if (expected !== undefined) {
      const actual = hasher.digest("hex")
      if (actual !== expected) {
        await this.cleanupPartial(partial)
        throw new ModelLoadError(
          `${modelId} checksum mismatch (expected ${expected}, got ${actual}); refusing to install`,
        )
      }
    }

    try {
      await rename(partial, target)
    } catch (cause) {
      await this.cleanupPartial(partial)
      throw new ModelLoadError(`failed to finalize ${modelId}`, cause)
    }

    try {
      await writeFile(sentinelPath(target), expected ?? "")
    } catch (cause) {
      throw new ModelLoadError(`failed to mark ${modelId} complete`, cause)
    }

    if (onProgress && lastReportedPercent !== 100) {
      onProgress(100)
    }
  }

  async remove(modelId: string): Promise<void> {
    const path = await this.pathFor(modelId)
    const sentinel = sentinelPath(path)
    try {
      await unlink(sentinel)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code !== "ENOENT") {
        throw new ModelLoadError(`failed to remove ${modelId} sentinel`, cause)
      }
    }
    try {
      await unlink(path)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === "ENOENT") return
      throw new ModelLoadError(`failed to remove ${modelId}`, cause)
    }
  }

  private targetPath(resolved: ResolvedModel): string {
    return join(this.baseDir, resolved.kind.subdir, resolved.entry.file)
  }

  private resolve(modelId: string): ResolvedModel {
    for (const kind of this.kinds) {
      const entry = kind.resolve(modelId)
      if (entry !== undefined) return { entry, kind }
    }
    throw new NotFoundError(`unknown model id: ${modelId}`)
  }

  private async cleanupPartial(partial: string): Promise<void> {
    try {
      await unlink(partial)
    } catch {
      // best-effort cleanup; ignore
    }
  }

  private async cleanupBadInstall(modelPath: string, sentinel: string): Promise<void> {
    for (const p of [modelPath, sentinel]) {
      try {
        await unlink(p)
      } catch {
        // best-effort; if we can't unlink, the next download() will rename
        // over the corrupt file anyway and isInstalled() will keep
        // returning false until then.
      }
    }
  }
}

function sentinelPath(modelPath: string): string {
  return `${modelPath}.complete`
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hasher = createHash("sha256")
    const stream = createReadStream(path)
    stream.on("error", reject)
    stream.on("data", (chunk) => {
      hasher.update(chunk)
    })
    stream.on("end", () => {
      resolve(hasher.digest("hex"))
    })
  })
}
