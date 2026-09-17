import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ModelLoadError,
  NotFoundError,
  getLlmModel,
  getWhisperModel,
  type LlmModelId,
  type WhisperModelId,
} from "@opennib/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  FsModelManager,
  LLM_MODEL_KIND,
  WHISPER_MODEL_KIND,
} from "../../../src/main/services/model-manager"

// Production Whisper AND LLM entries carry a sha256 of the real model file;
// tests stream tiny synthetic bodies that obviously won't match. Override the
// registry's sha256 per-test with the digest of whatever bytes the test
// actually feeds in, so the post-download verification accepts the body.
const { whisperShaOverrides, llmShaOverrides } = vi.hoisted(() => ({
  whisperShaOverrides: new Map<string, string>(),
  llmShaOverrides: new Map<string, string>(),
}))

vi.mock("@opennib/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opennib/core")>()
  return {
    ...actual,
    getWhisperModel: (id: WhisperModelId) => {
      const original = actual.getWhisperModel(id)
      const override = whisperShaOverrides.get(id)
      return override !== undefined ? { ...original, sha256: override } : original
    },
    getLlmModel: (id: LlmModelId) => {
      const original = actual.getLlmModel(id)
      const override = llmShaOverrides.get(id)
      return override !== undefined ? { ...original, sha256: override } : original
    },
  }
})

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(body)).digest("hex")
}

function makeResponse(body: Uint8Array, opts: { status?: number; total?: number } = {}): Response {
  const status = opts.status ?? 200
  const total = opts.total ?? body.byteLength
  const headers = new Headers()
  if (total > 0) headers.set("content-length", String(total))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body)
      controller.close()
    },
  })
  return new Response(stream, { status, headers })
}

describe("FsModelManager", () => {
  let baseDir: string

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "opennib-models-"))
    whisperShaOverrides.clear()
    llmShaOverrides.clear()
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it("resolves pathFor under the configured base dir", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })
    const path = await mgr.pathFor("base")
    expect(path).toBe(join(baseDir, "whisper", getWhisperModel("base").file))
  })

  it("throws NotFoundError for unknown model ids", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })
    await expect(mgr.pathFor("not-a-real-model")).rejects.toBeInstanceOf(NotFoundError)
    await expect(mgr.isInstalled("not-a-real-model")).rejects.toBeInstanceOf(NotFoundError)
    await expect(mgr.download("not-a-real-model")).rejects.toBeInstanceOf(NotFoundError)
    await expect(mgr.remove("not-a-real-model")).rejects.toBeInstanceOf(NotFoundError)
  })

  it("isInstalled returns false when the file is missing", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })
    expect(await mgr.isInstalled("base")).toBe(false)
  })

  it("isInstalled returns true after a successful download", async () => {
    const body = new TextEncoder().encode("ggml-bytes")
    whisperShaOverrides.set("base", sha256Hex(body))
    const fetchImpl = vi.fn(async () => makeResponse(body)) as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })

    await mgr.download("base")

    expect(await mgr.isInstalled("base")).toBe(true)
    const path = await mgr.pathFor("base")
    const written = await readFile(path)
    expect(new Uint8Array(written)).toEqual(body)
  })

  it("download fetches the URL from the registry", async () => {
    const body = new Uint8Array([1, 2, 3])
    whisperShaOverrides.set("tiny", sha256Hex(body))
    const fetchImpl = vi.fn(async () => makeResponse(body))
    const mgr = new FsModelManager({ baseDir, fetchImpl: fetchImpl as unknown as typeof fetch })

    await mgr.download("tiny")

    expect(fetchImpl).toHaveBeenCalledWith(getWhisperModel("tiny").downloadUrl)
  })

  it("emits progress callbacks based on content-length", async () => {
    const body = new Uint8Array(100)
    whisperShaOverrides.set("base", sha256Hex(body))
    const fetchImpl = vi.fn(async () =>
      makeResponse(body, { total: 100 }),
    ) as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })

    const progress: number[] = []
    await mgr.download("base", (p) => progress.push(p))

    expect(progress.at(-1)).toBe(100)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((p) => p >= 0 && p <= 100)).toBe(true)
  })

  it("emits a 100% progress event even when content-length is missing", async () => {
    const body = new Uint8Array(10)
    whisperShaOverrides.set("base", sha256Hex(body))
    const headers = new Headers()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(body)
        c.close()
      },
    })
    const response = new Response(stream, { status: 200, headers })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })

    const progress: number[] = []
    await mgr.download("base", (p) => progress.push(p))

    expect(progress).toEqual([100])
  })

  it("throws ModelLoadError on non-2xx responses", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 404, statusText: "Not Found" }),
    ) as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })

    await expect(mgr.download("base")).rejects.toBeInstanceOf(ModelLoadError)
  })

  it("wraps fetch failures as ModelLoadError with cause", async () => {
    const networkErr = new Error("ECONNREFUSED")
    const fetchImpl = vi.fn(async () => {
      throw networkErr
    }) as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })

    try {
      await mgr.download("base")
      throw new Error("expected ModelLoadError")
    } catch (err) {
      expect(err).toBeInstanceOf(ModelLoadError)
      expect((err as ModelLoadError).cause).toBe(networkErr)
    }
  })

  it("does not leave a .partial file on success", async () => {
    const body = new Uint8Array([1, 2, 3])
    whisperShaOverrides.set("base", sha256Hex(body))
    const fetchImpl = vi.fn(async () => makeResponse(body)) as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })

    await mgr.download("base")

    const target = await mgr.pathFor("base")
    await expect(stat(`${target}.partial`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("remove deletes an installed model", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    whisperShaOverrides.set("base", sha256Hex(bytes))
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })

    const path = await mgr.pathFor("base")
    const dir = path.slice(0, path.lastIndexOf("/"))
    await writeFile(path, bytes.slice(), { flag: "w" }).catch(async () => {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(dir, { recursive: true })
      await writeFile(path, bytes)
    })

    expect(await mgr.isInstalled("base")).toBe(true)
    await mgr.remove("base")
    expect(await mgr.isInstalled("base")).toBe(false)
  })

  it("remove is idempotent for missing files", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })
    await expect(mgr.remove("base")).resolves.toBeUndefined()
  })

  it("routes Whisper and LLM ids to their own subdirectories when both kinds are registered", async () => {
    const body = new Uint8Array([1, 2, 3])
    const fetchImpl = vi.fn(async () => makeResponse(body))
    const mgr = new FsModelManager({
      baseDir,
      kinds: [WHISPER_MODEL_KIND, LLM_MODEL_KIND],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const llmId = "qwen2.5-0.5b-instruct-q4"
    llmShaOverrides.set(llmId, sha256Hex(body))
    const whisperPath = await mgr.pathFor("base")
    const llmPath = await mgr.pathFor(llmId)

    expect(whisperPath).toBe(join(baseDir, "whisper", getWhisperModel("base").file))
    expect(llmPath).toBe(join(baseDir, "llm", getLlmModel(llmId).file))

    await mgr.download(llmId)
    expect(fetchImpl).toHaveBeenCalledWith(getLlmModel(llmId).downloadUrl)
    expect(await mgr.isInstalled(llmId)).toBe(true)
    expect(await mgr.isInstalled("base")).toBe(false)
  })

  it("rejects an LLM id when only the Whisper kind is registered", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const mgr = new FsModelManager({ baseDir, fetchImpl })
    await expect(mgr.pathFor("qwen2.5-0.5b-instruct-q4")).rejects.toBeInstanceOf(NotFoundError)
  })
})
