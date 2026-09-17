import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { CleanupError } from "@opennib/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { CoreWorkerClient, CoreWorkerError } from "../../../src/main/services/core-worker"

// Absolute path to the real Bare worker entry (`bare/core-worker.mjs`).
const WORKER_PATH = fileURLToPath(new URL("../../../bare/core-worker.mjs", import.meta.url))

// This test spawns the REAL Bare worker (real `bare` binary, real unix socket,
// real Hypercore in tmp dirs) and round-trips the non-model RPC surface. It
// deliberately never loads a whisper/LLM model — the worker registers SDK
// plugins at INIT but no weights are touched, so it stays fast and offline.
//
// Unix-socket `listen()` is blocked in some sandboxes (EPERM). If that bites,
// set OPENNIB_SKIP_WORKER_IT=1 to skip; CI outside the sandbox runs it for real.
const skip = process.env.OPENNIB_SKIP_WORKER_IT === "1"

describe.skipIf(skip)("CoreWorkerClient (real worker)", () => {
  let scratch: string
  let client: CoreWorkerClient

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "opennib-core-worker-it-"))
    client = new CoreWorkerClient()
    await client.start({
      workerPath: WORKER_PATH,
      historyDir: join(scratch, "history"),
      dictionaryDir: join(scratch, "dictionary"),
      // Bind the socket in the OS temp root (short path): unix `sun_path` caps
      // at ~104 bytes, and `scratch` is a deeply nested mkdtemp dir.
      socketDir: tmpdir(),
    })
  }, 20_000)

  afterEach(async () => {
    await client.dispose()
    await rm(scratch, { recursive: true, force: true })
  }, 10_000)

  it("round-trips history append + list", async () => {
    const history = client.history()
    await expect(history.list()).resolves.toEqual([])

    // `createdAt` must be inside the 30-day retention window — history.list()
    // silently drops older entries, so an epoch-ish timestamp would read back
    // as empty even though the append succeeded.
    const entry = {
      id: "t1",
      createdAt: Date.now(),
      text: "hello world",
      language: "en",
      durationMs: 1_200,
    }
    await history.append(entry)

    const entries = await history.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject(entry)
  })

  it("round-trips dictionary add + list + remove", async () => {
    const dictionary = client.dictionary()
    // The dictionary is seeded with default terms, so we assert on our own
    // entry's presence/absence rather than the whole list being empty.
    const initialIds = (await dictionary.list()).map((e) => e.id)
    expect(initialIds).not.toContain("d1")

    await dictionary.add({ id: "d1", term: "opennib", createdAt: Date.now() })
    const added = await dictionary.list()
    expect(added.find((e) => e.id === "d1")).toMatchObject({ id: "d1", term: "opennib" })

    await dictionary.remove("d1")
    const afterRemove = await dictionary.list()
    expect(afterRemove.find((e) => e.id === "d1")).toBeUndefined()
  })

  it("cleanup without a configured cleaner rejects with a typed CleanupError", async () => {
    const cleaner = client.cleaner()
    await expect(cleaner.cleanup("some text", "en")).rejects.toBeInstanceOf(CleanupError)
  })

  it("rejects requests after dispose", async () => {
    await client.dispose()
    await expect(client.history().list()).rejects.toBeInstanceOf(CoreWorkerError)
  })
})
