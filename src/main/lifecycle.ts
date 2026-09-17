import { log } from "@opennib/core"

import { errorMessage } from "./error-message"
import type { RunningPipeline } from "./start-pipeline"

// Each teardown step is bounded so a hang in one (typically the SDK unload over
// the Bare worker IPC) doesn't prevent later steps from running. The overall
// teardown is also bounded by TEARDOWN_HARD_TIMEOUT_MS — if anything is still
// pending after that, we force-exit. Releasing the corestore fd-locks is more
// important than a graceful SDK shutdown: a leaked SDK Bare worker is a leak,
// but a held fd-lock prevents the next dev session from booting at all.
export const TEARDOWN_STEP_TIMEOUT_MS = 1500
export const TEARDOWN_HARD_TIMEOUT_MS = 4000

async function withTimeout<T>(label: string, op: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      log.warn("teardown step timed out", { step: label, timeoutMs: ms })
      resolve(undefined)
    }, ms)
  })
  try {
    return (await Promise.race([op, timeout])) as T | undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function teardown(running: RunningPipeline): Promise<void> {
  const r = running

  // Order matters: close the corestores FIRST so the fd-locks are released
  // even if the SDK or pipeline hangs on shutdown. The previous order put
  // SDK teardown first, which left fd-locks held when transcriber.unloadAll()
  // hung — the next dev session then couldn't open history/dictionary.
  try {
    await withTimeout("history.close", r.services.history.close(), TEARDOWN_STEP_TIMEOUT_MS)
  } catch (err) {
    log.error("history close failed", { error: errorMessage(err) })
  }
  try {
    await withTimeout("dictionary.close", r.services.dictionary.close(), TEARDOWN_STEP_TIMEOUT_MS)
  } catch (err) {
    log.error("dictionary close failed", { error: errorMessage(err) })
  }
  try {
    await withTimeout("pipeline.stop", r.stop(), TEARDOWN_STEP_TIMEOUT_MS)
  } catch (err) {
    log.error("pipeline stop failed", { error: errorMessage(err) })
  }
  try {
    await withTimeout(
      "transcriber.unloadAll",
      r.services.transcriber.unloadAll(),
      TEARDOWN_STEP_TIMEOUT_MS,
    )
  } catch (err) {
    log.error("transcriber unload failed", { error: errorMessage(err) })
  }
  try {
    await withTimeout("cleaner.dispose", r.services.cleaner.dispose(), TEARDOWN_STEP_TIMEOUT_MS)
  } catch (err) {
    log.error("cleaner dispose failed", { error: errorMessage(err) })
  }
  // Dispose the core worker LAST: its SHUTDOWN handler is what actually closes
  // the Hypercore stores (releasing fd-locks) and unloads the SDK inside the
  // worker, then the child is killed. The store/engine steps above are RPC
  // calls into this same worker, so they must complete (or time out) first.
  try {
    await withTimeout(
      "coreWorker.dispose",
      r.services.coreWorker.dispose(),
      TEARDOWN_STEP_TIMEOUT_MS,
    )
  } catch (err) {
    log.error("core worker dispose failed", { error: errorMessage(err) })
  }
}

/**
 * Wraps a teardown function so multiple callers (before-quit, SIGTERM, SIGINT)
 * race to the same in-flight promise instead of triggering parallel teardowns.
 */
export function makeTeardownOnce(
  getRunning: () => RunningPipeline | null,
  clearRunning: () => void,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null
  return () => {
    if (inFlight !== null) return inFlight
    const r = getRunning()
    if (r === null) {
      inFlight = Promise.resolve()
      return inFlight
    }
    clearRunning()
    inFlight = teardown(r)
    return inFlight
  }
}
