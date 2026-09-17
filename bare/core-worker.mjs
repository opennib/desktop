// Desktop core worker. Runs under the Bare runtime, spawned by Electron main
// (see src/main/services/core-worker.ts). Hosts the AI engines (@qvac/sdk
// whisper + llama) and Hypercore-backed History + Dictionary INSIDE this
// subprocess, so Electron main never loads native binaries or holds the
// corestore fd-locks itself — it is a pure RPC client.
//
// Transport: connect back to the host's unix socket (last Bare.argv entry) over
// bare-net, then serve the generated typed HRPC contract (@opennib/core/hrpc,
// compact-encoding over bare-rpc). The SDK, when imported under Bare, selects
// Bare-direct mode — models run in THIS process, so we register the whisper +
// llama plugins once before the first SDK call.
//
// The generated handler has NO try/catch: a throwing handler hangs the caller.
// Every handler is therefore wrapped in `guard`, which converts a thrown error
// into the response's `error {name, message}` envelope (rehydrated client-side
// into the matching OpennibError subclass).
import net from "bare-net"
import fs from "bare-fs"
import os from "bare-os"

import HRPC from "@opennib/core/hrpc"
import { HypercoreHistory, HypercoreDictionary } from "@opennib/core/hypercore"
import { WhisperTranscriber } from "@opennib/core/whisper-transcriber"
import { LlmCleaner } from "@opennib/core/llm-cleaner"

// Filesystem slice the Hypercore stores need for compaction (rename / remove /
// exists). Injected rather than imported by core so core stays runtime-neutral.
const storageFs = {
  rename: (from, to) => fs.promises.rename(from, to),
  remove: (path) => fs.promises.rm(path, { recursive: true, force: true }),
  exists: async (path) => {
    try {
      await fs.promises.stat(path)
      return true
    } catch {
      return false
    }
  },
}

// State constructed by INIT. Every non-INIT handler checks these are set and
// fails with a typed error otherwise, so a misordered client can't crash the
// worker — it gets a clean error reply instead.
let history = null
let dictionary = null
let transcriber = null
let cleaner = null
let pluginsRegistered = false

/**
 * WAV-file AudioEncoder for the worker. Same contract as the desktop main
 * `WavFileAudioEncoder` (f32le IEEE-float WAV → temp file → cleanup deletes
 * it) but on bare-fs/bare-os so it runs under Bare. Kept inline because the
 * worker is self-contained, mirroring the mobile worker.
 *
 * `audioFormat` must be "f32le": ffmpeg decodes WAV format=3 to f32le, which
 * is what whisper ends up seeing and must match `audio_format` in modelConfig.
 */
const wavFileAudioEncoder = {
  audioFormat: "f32le",
  async encode(frame) {
    const dir = await fs.promises.mkdtemp(join(os.tmpdir(), "opennib-audio-"))
    const filePath = join(dir, "frame.wav")
    await fs.promises.writeFile(filePath, wrapAsWavFloat32(frame.samples, frame.sampleRate))
    return {
      chunk: filePath,
      cleanup: async () => {
        await fs.promises.rm(dir, { recursive: true, force: true })
      },
    }
  },
}

function wrapAsWavFloat32(samples, sampleRate) {
  const numChannels = 1
  const bitsPerSample = 32
  const bytesPerSample = bitsPerSample / 8
  const dataLength = samples.byteLength
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + dataLength, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(3, 20) // 3 = IEEE float
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28)
  header.writeUInt16LE(numChannels * bytesPerSample, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write("data", 36)
  header.writeUInt32LE(dataLength, 40)
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  return Buffer.concat([header, data])
}

// bare-path isn't imported (path is not on core's allow list, but this is
// worker glue, not core). A trivial POSIX join keeps the worker dependency
// surface minimal — unix sockets + temp dirs are always POSIX here.
function join(...parts) {
  return parts.join("/").replace(/\/+/g, "/")
}

/**
 * Wrap an HRPC handler so a thrown error becomes the response's `error`
 * envelope instead of hanging the caller (the generated handler has no
 * try/catch). `nullFields` are the non-`error` fields of the response struct,
 * defaulted so the compact-encoding encode step still has every field present.
 */
function guard(fn, nullFields = {}) {
  return async (req) => {
    try {
      return await fn(req)
    } catch (err) {
      return {
        error: { name: err?.name ?? "OpennibError", message: err?.message ?? String(err) },
        ...nullFields,
      }
    }
  }
}

/**
 * Register the whisper + llama SDK plugins exactly once. Bare-direct mode
 * requires plugins to be registered before the first loadModel call, and
 * re-registering is wasteful, so we gate on a flag.
 */
async function ensurePlugins() {
  if (pluginsRegistered) return
  const { plugins } = await import("@qvac/sdk")
  const { whisperPlugin } = await import("@qvac/sdk/whispercpp-transcription/plugin")
  const { llmPlugin } = await import("@qvac/sdk/llamacpp-completion/plugin")
  plugins([whisperPlugin, llmPlugin])
  pluginsRegistered = true
}

function requireInit() {
  if (history === null || dictionary === null || transcriber === null) {
    throw new Error("core worker command received before INIT")
  }
}

const socketPath = Bare.argv[Bare.argv.length - 1]
const socket = net.connect(socketPath)
const rpc = new HRPC(socket)

rpc.onInit(
  guard(async (req) => {
    const { historyDir, dictionaryDir } = req
    if (typeof historyDir !== "string" || typeof dictionaryDir !== "string") {
      throw new Error("INIT payload missing historyDir/dictionaryDir")
    }
    await ensurePlugins()
    history = new HypercoreHistory({ storagePath: historyDir, fs: storageFs })
    dictionary = new HypercoreDictionary({ storagePath: dictionaryDir, fs: storageFs })
    transcriber = new WhisperTranscriber({ audioEncoder: wavFileAudioEncoder })
    return { error: null }
  }),
)

rpc.onTranscriberPreload(
  guard(async (req) => {
    requireInit()
    await transcriber.preload(req.modelPath, req.language)
    return { error: null }
  }),
)

rpc.onTranscribe(
  guard(
    async (req) => {
      requireInit()
      // The decoded `samples` buffer is an UNALIGNED subarray view into the RPC
      // frame; copy it before wrapping it in a Float32Array or the view may
      // straddle a non-4-byte offset (and the frame bytes may be reused).
      const copy = new Uint8Array(req.samples)
      const samples = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
      const frame = { samples, sampleRate: req.sampleRate, durationMs: req.durationMs }
      const text = await transcriber.transcribe(frame, req.modelPath, req.language)
      return { error: null, text }
    },
    { text: null },
  ),
)

rpc.onTranscriberUnloadAll(
  guard(async () => {
    requireInit()
    await transcriber.unloadAll()
    return { error: null }
  }),
)

rpc.onCleanerConfigure(
  guard(async (req) => {
    requireInit()
    const { modelPath } = req
    if (modelPath === null) {
      await cleaner?.unload()
      cleaner = null
      return { error: null }
    }
    await cleaner?.unload()
    await ensurePlugins()
    cleaner = new LlmCleaner({ modelPath })
    return { error: null }
  }),
)

rpc.onCleanerCleanup(
  guard(
    async (req) => {
      requireInit()
      if (cleaner === null) {
        // Surface as a CleanupError so the client's rehydration gives the
        // caller the same typed error it would have raised in-process.
        const err = new Error("no cleaner configured")
        err.name = "CleanupError"
        throw err
      }
      // `terms` is null (not undefined) when the optional array is absent.
      const cleaned = await cleaner.cleanup(req.text, req.language, req.terms ?? undefined)
      return { error: null, text: cleaned }
    },
    { text: null },
  ),
)

rpc.onHistoryAppend(
  guard(async (req) => {
    requireInit()
    await history.append(req.entry)
    return { error: null }
  }),
)

rpc.onHistoryList(
  guard(
    async (req) => {
      requireInit()
      // `limit` 0/null means "no limit"; `before` null means "from newest".
      const options = {}
      if (req.limit) options.limit = req.limit
      if (req.before) options.before = req.before
      const entries = await history.list(options)
      return { error: null, entries }
    },
    { entries: null },
  ),
)

rpc.onHistoryClear(
  guard(async () => {
    requireInit()
    await history.clear()
    return { error: null }
  }),
)

rpc.onDictionaryList(
  guard(
    async () => {
      requireInit()
      const entries = await dictionary.list()
      return { error: null, entries }
    },
    { entries: null },
  ),
)

rpc.onDictionaryAdd(
  guard(async (req) => {
    requireInit()
    await dictionary.add(req)
    return { error: null }
  }),
)

rpc.onDictionaryRemove(
  guard(async (req) => {
    requireInit()
    await dictionary.remove(req.id)
    return { error: null }
  }),
)

rpc.onDictionaryClear(
  guard(async () => {
    requireInit()
    await dictionary.clear()
    return { error: null }
  }),
)

rpc.onShutdown(
  guard(async () => {
    // Best-effort teardown of everything the worker owns. Order mirrors
    // desktop lifecycle: release corestore fd-locks first, then unload the
    // native engines. The host kills this process right after the reply.
    if (history !== null) await history.close()
    if (dictionary !== null) await dictionary.close()
    if (transcriber !== null) await transcriber.unloadAll()
    if (cleaner !== null) await cleaner.unload()
    history = null
    dictionary = null
    transcriber = null
    cleaner = null
    return { error: null }
  }),
)
