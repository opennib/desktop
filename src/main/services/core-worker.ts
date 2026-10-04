import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { join } from "node:path"

import spawn from "bare-runtime/spawn"

import {
  OpennibError,
  log,
  type AudioFrame,
  type Cleaner,
  type Dictionary,
  type DictionaryEntry,
  type History,
  type HistoryListOptions,
  type LanguageTag,
  type TranscriptEntry,
  type Transcriber,
} from "@opennib/core"
import HRPC from "@opennib/core/hrpc"
import type { HrpcAck, HrpcError, HrpcTextResponse } from "@opennib/core/hrpc"
import { rehydrateError } from "@opennib/core/rpc"

import { errorMessage } from "../error-message"

/** Raised when the worker fails to boot, exits unexpectedly, or a request times out. */
export class CoreWorkerError extends OpennibError {}

/** How long we wait for the worker to connect + acknowledge INIT before giving up. */
const START_TIMEOUT_MS = 15_000
/** How long we wait for the SHUTDOWN reply before killing the child anyway. */
const SHUTDOWN_TIMEOUT_MS = 1_500

export interface CoreWorkerStartOptions {
  /** Absolute path to `bare/core-worker.mjs`. */
  readonly workerPath: string
  /** Directory Hypercore uses for the transcript history log. */
  readonly historyDir: string
  /** Directory Hypercore uses for the dictionary event log. */
  readonly dictionaryDir: string
  /**
   * Directory for the unix socket the host listens on. Should be the app's
   * temp or userData dir. A unique socket filename is generated inside it.
   */
  readonly socketDir: string
}

/** The transcriber surface the client exposes: `Transcriber` plus lifecycle. */
export interface RpcTranscriberHandle extends Transcriber {
  preload(modelPath: string, language: LanguageTag): Promise<void>
  unloadAll(): Promise<void>
}

/** The history surface the client exposes: `History` plus an idempotent `close`. */
export interface RpcHistoryHandle extends History {
  close(): Promise<void>
}

/** The dictionary surface the client exposes: `Dictionary` plus an idempotent `close`. */
export interface RpcDictionaryHandle extends Dictionary {
  close(): Promise<void>
}

/**
 * Throw the matching `OpennibError` subclass when the worker returned an error
 * envelope, otherwise return the (validated) response. Written once so every
 * adapter call unwraps the generated contract identically.
 */
function unwrap<T extends { readonly error: HrpcError | null }>(res: T): T {
  if (res.error !== null) throw rehydrateError(res.error.name, res.error.message)
  return res
}

/**
 * Electron-main-side client for the desktop core worker (bare/core-worker.mjs).
 *
 * Spawns the Bare worker as a subprocess, opens a typed HRPC channel over a
 * unix socket, and exposes RPC-backed adapters implementing the core
 * `Transcriber`, `Cleaner`, `History`, and `Dictionary` interfaces. The AI
 * engines and Hypercore stores live entirely inside the worker; this class is a
 * pure client. `dispose()` is what actually closes Hypercore + unloads the SDK
 * (via the worker's SHUTDOWN handler) before the child is killed.
 */
export class CoreWorkerClient {
  private server: Server | null = null
  private child: ChildProcess | null = null
  private rpc: HRPC | null = null
  private socket: Socket | null = null
  private socketPath: string | null = null
  private disposed = false

  async start(options: CoreWorkerStartOptions): Promise<void> {
    if (this.rpc !== null) {
      throw new CoreWorkerError("core worker already started")
    }

    // Unix domain socket paths are capped by the OS `sun_path` length (~104
    // bytes on macOS). `socketDir` is often a long `/var/folders/…/T` path, so
    // keep the filename short — a full UUID here overruns the cap and the
    // worker's `net.connect` fails with EINVAL ("invalid argument").
    // POSIX: a unix socket in the temp dir (short name — macOS caps sun_path
    // at ~104 bytes and the temp dir is long). Windows has no unix sockets;
    // Node and Bare both speak named pipes under the \\.\pipe\ namespace,
    // which is flat and needs no directory.
    const id = randomUUID().slice(0, 8)
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\onib-${id}`
        : join(options.socketDir, `onib-${id}.sock`)
    this.socketPath = socketPath

    // Bind the socket BEFORE spawning the worker: the worker's bare-net
    // `connect(socketPath)` fires immediately on boot, and if the server isn't
    // listening yet it gets ECONNREFUSED and the worker exits silently (code 0)
    // with nothing to keep its event loop alive. Awaiting `listening` first
    // removes that race.
    const connected = new Promise<HRPC>((resolve, reject) => {
      const server = createServer((socket: Socket) => {
        this.socket = socket
        resolve(new HRPC(socket))
      })
      this.server = server
      server.on("error", (err) => {
        reject(new CoreWorkerError(`core worker socket server failed: ${errorMessage(err)}`, err))
      })
      server.listen(socketPath)
    })

    await new Promise<void>((resolve, reject) => {
      const server = this.server
      if (server === null) {
        reject(new CoreWorkerError("core worker socket server missing"))
        return
      }
      if (server.listening) {
        resolve()
        return
      }
      server.once("listening", resolve)
      server.once("error", (err) =>
        reject(new CoreWorkerError(`core worker socket bind failed: ${errorMessage(err)}`, err)),
      )
    })

    // Race worker-connected against worker-exited-early and a hard timeout, so
    // a boot failure (bad worker path, missing bare binary, SDK import throw)
    // fails fast with a typed error instead of hanging app startup.
    const child = spawn("bare", {
      args: [options.workerPath, socketPath],
      stdio: ["ignore", "inherit", "inherit"],
      // Without this, Windows opens a console window for the worker.
      windowsHide: true,
    })
    this.child = child

    const exitedEarly = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code: number | null, signal: string | null) => {
        // A non-zero/undefined exit before we finish starting is a boot
        // failure. After startup the general exit handler (installed below)
        // handles unexpected death.
        reject(
          new CoreWorkerError(
            `core worker exited during startup (code=${String(code)} signal=${String(signal)})`,
          ),
        )
      })
    })

    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new CoreWorkerError(`core worker did not start within ${START_TIMEOUT_MS}ms`))
      }, START_TIMEOUT_MS).unref()
    })

    try {
      const rpc = await Promise.race([connected, exitedEarly, timeout])
      this.rpc = rpc
      // Remove the startup-only exit listener and install the steady-state one
      // so a later crash fails in-flight requests. hrpc has no request registry
      // we can reach, so we destroy the underlying socket: bare-rpc then
      // rejects every pending `request.reply()` promise (see reject-after-death
      // integration test).
      child.removeAllListeners("exit")
      child.once("exit", (code: number | null, signal: string | null) => {
        if (this.disposed) return
        log.error("core worker exited unexpectedly", { code, signal })
        this.destroySocket(
          new CoreWorkerError(
            `core worker exited unexpectedly (code=${String(code)} signal=${String(signal)})`,
          ),
        )
      })
      unwrap(
        await rpc.init({ historyDir: options.historyDir, dictionaryDir: options.dictionaryDir }),
      )
      log.info("core worker started", {
        historyDir: options.historyDir,
        dictionaryDir: options.dictionaryDir,
      })
    } catch (err) {
      // Startup failed: tear down whatever partially came up so we don't leak
      // the child or the socket. Re-throw as a typed error for the caller.
      await this.cleanupTransport()
      throw err instanceof CoreWorkerError
        ? err
        : new CoreWorkerError(`core worker start failed: ${errorMessage(err)}`, err)
    }
  }

  private client(): HRPC {
    if (this.rpc === null) throw new CoreWorkerError("core worker not started")
    return this.rpc
  }

  transcriber(): RpcTranscriberHandle {
    const self = this
    return {
      async transcribe(frame: AudioFrame, modelPath: string, language: LanguageTag) {
        // The frame's samples ride the wire as raw f32le bytes (compact-encoding
        // `buffer`), no hand-rolled envelope.
        const samples = new Uint8Array(
          frame.samples.buffer,
          frame.samples.byteOffset,
          frame.samples.byteLength,
        )
        const res = unwrap<HrpcTextResponse>(
          await self.client().transcribe({
            samples,
            sampleRate: frame.sampleRate,
            durationMs: frame.durationMs,
            modelPath,
            language,
          }),
        )
        return res.text ?? ""
      },
      async preload(modelPath: string, language: LanguageTag) {
        unwrap<HrpcAck>(await self.client().transcriberPreload({ modelPath, language }))
      },
      async unloadAll() {
        unwrap<HrpcAck>(await self.client().transcriberUnloadAll({}))
      },
    }
  }

  /**
   * Configure the worker's LLM cleaner: pass a model path to (re)load it, or
   * `null` to unload cleanup entirely.
   */
  async configureCleaner(modelPath: string | null): Promise<void> {
    unwrap<HrpcAck>(await this.client().cleanerConfigure({ modelPath }))
  }

  cleaner(): Cleaner {
    const self = this
    return {
      async cleanup(text: string, language: LanguageTag, terms?: readonly DictionaryEntry[]) {
        const res = unwrap<HrpcTextResponse>(
          await self.client().cleanerCleanup({ text, language, terms: terms ?? null }),
        )
        return res.text ?? ""
      },
    }
  }

  history(): RpcHistoryHandle {
    const self = this
    return {
      async append(entry: TranscriptEntry) {
        unwrap<HrpcAck>(await self.client().historyAppend({ entry }))
      },
      async list(options?: HistoryListOptions) {
        const res = unwrap(
          await self.client().historyList({
            limit: options?.limit ?? null,
            before: options?.before ?? null,
          }),
        )
        return res.entries ?? []
      },
      async clear() {
        unwrap<HrpcAck>(await self.client().historyClear({}))
      },
      // Real closing happens in dispose() via SHUTDOWN. Kept because
      // lifecycle.ts calls it in teardown; idempotent no-op over RPC.
      async close() {},
    }
  }

  dictionary(): RpcDictionaryHandle {
    const self = this
    return {
      async list() {
        const res = unwrap(await self.client().dictionaryList({}))
        return res.entries ?? []
      },
      async add(entry: DictionaryEntry) {
        unwrap<HrpcAck>(await self.client().dictionaryAdd(entry))
      },
      async remove(id: string) {
        unwrap<HrpcAck>(await self.client().dictionaryRemove({ id }))
      },
      async clear() {
        unwrap<HrpcAck>(await self.client().dictionaryClear({}))
      },
      // See history().close — real teardown is SHUTDOWN-driven; this is a no-op.
      async close() {},
    }
  }

  /**
   * Graceful teardown: ask the worker to close Hypercore + unload the SDK
   * (best-effort, short timeout), then kill the child and remove the socket.
   * Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const rpc = this.rpc
    if (rpc !== null) {
      try {
        await Promise.race([
          rpc.shutdown({}).then((res) => {
            unwrap<HrpcAck>(res)
          }),
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
        ])
      } catch (err) {
        // A failed graceful shutdown must not block killing the child — the
        // whole point is to release fd-locks even if the worker is wedged.
        log.warn("core worker shutdown request failed", { error: errorMessage(err) })
      }
    }
    await this.cleanupTransport()
  }

  /**
   * Destroy the transport so bare-rpc rejects every in-flight `request.reply()`
   * promise. Used when the child dies unexpectedly: hrpc exposes no pending-
   * request registry, but tearing down the socket propagates a stream error
   * into each waiting request.
   */
  private destroySocket(err: CoreWorkerError): void {
    if (this.socket !== null) {
      this.socket.destroy(err)
      this.socket = null
    }
    this.rpc = null
  }

  private async cleanupTransport(): Promise<void> {
    if (this.child !== null) {
      this.child.removeAllListeners("exit")
      try {
        this.child.kill("SIGTERM")
      } catch (err) {
        log.warn("core worker kill failed", { error: errorMessage(err) })
      }
      this.child = null
    }
    if (this.socket !== null) {
      this.socket.destroy()
      this.socket = null
    }
    if (this.server !== null) {
      this.server.close()
      this.server = null
    }
    this.rpc = null
    // Unix sockets leave a file behind; Windows named pipes vanish with the server.
    if (this.socketPath !== null && process.platform !== "win32") {
      try {
        await rm(this.socketPath, { force: true })
      } catch (err) {
        // Socket-file cleanup is best-effort: a leaked socket file in the temp
        // dir is harmless (each start uses a fresh unique name).
        log.warn("core worker socket cleanup failed", { error: errorMessage(err) })
      }
    }
    this.socketPath = null
  }
}
