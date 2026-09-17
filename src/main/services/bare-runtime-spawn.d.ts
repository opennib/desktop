// bare-runtime ships no types for its `spawn` subpath. It returns a Node
// child process (the runtime resolves the platform `bare` binary from
// `bare-runtime-<platform>-<arch>` and spawns it), so we type it against
// Node's ChildProcess — that is exactly what it hands back when called from
// Electron main, the same as @qvac/sdk's own node-rpc-client uses it.
declare module "bare-runtime/spawn" {
  import type { ChildProcess, SpawnOptions } from "node:child_process"

  interface BareSpawnOptions extends SpawnOptions {
    readonly args?: readonly string[]
    readonly suppressSignals?: boolean
    readonly forwardExitCode?: boolean
  }

  export default function spawn(referrer: string, opts?: BareSpawnOptions): ChildProcess
  export default function spawn(opts?: BareSpawnOptions): ChildProcess
}
