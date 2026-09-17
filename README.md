# opennib desktop

<p>
  <a href="https://github.com/tetherto/qvac"><picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-inline-green-dark.svg">
    <img alt="Built with QVAC" src="https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-inline-green-light.svg">
  </picture></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1f6feb?style=flat&labelColor=4b5563"></a>
</p>

Free, open-source, **fully local** dictation for macOS, Windows, and Linux. Hold a key, speak, and the text lands in whatever app you were already typing in.

- **Push-to-talk** — a global hotkey with real key-release detection (including the macOS Fn key), so recording stops the moment you let go.
- **On-device Whisper** — transcription runs locally through [`@qvac/sdk`](https://www.npmjs.com/package/@qvac/sdk); multilingual, with auto-detect or a pinned language.
- **Optional local-LLM cleanup** — punctuation and capitalization fixed by a small model on your machine. Best-effort: it falls back to the raw transcript rather than blocking the paste.
- **Custom dictionary** — spell your own names and jargon correctly.
- **Append-only history** — transcripts kept in a local [Hypercore](https://github.com/holepunchto/hypercore) log.

No cloud, no accounts, no telemetry. Audio and transcripts never leave the machine.

This is the Electron shell. All the business logic lives in [`@opennib/core`](https://github.com/opennib/core) — this repo owns the platform adapters (recording, hotkeys, text insertion, notifications, permissions, model files, settings) and the UI.

## Requirements

- Node.js ≥ 22.17 and npm
- **macOS:** Xcode command-line tools (`xcode-select --install`) — `swiftc` compiles the two native helpers
- **Linux:** `wtype` (Wayland) or `xdotool` (X11) on `PATH` for text insertion

## Quick start

```sh
npm install
npm run build:native   # macOS only; a no-op elsewhere
npm run dev
```

`npm run dev` starts electron-vite with HMR for the renderer.

## Architecture

```
 Electron main  ── the HOST
 hotkey · audio capture · paste · tray + windows · IPC
        │
        │  typed RPC over a unix socket
        │  (@opennib/core/hrpc — compact-encoding, append-only)
        ▼
 bare/core-worker.mjs  ── a Bare child process
 ┌──────────────────────────────────────────────┐
 │ WhisperTranscriber · LlmCleaner   ← @qvac/sdk│
 │ HypercoreHistory · HypercoreDictionary       │
 └──────────────────────────────────────────────┘
```

Electron main never loads a native AI binary and never holds a corestore
file lock. It spawns `bare/core-worker.mjs` under the [Bare](https://github.com/holepunchto/bare)
runtime, connects over a unix socket, and drives it through the typed
contract `@opennib/core` generates. The worker script is thin glue: one
handler per command, each forwarding to core.

The renderer is a plain Vite app (HTML / TS / CSS). It talks to main only
through the typed surface the preload bridge exposes on `window.opennib`;
there is no business logic in the preload or the renderer.

The adapters in `src/main/services/` implement the interfaces core declares:

| Adapter                                          | Implements                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `hotkey.ts` / `global-key-hotkey.ts`             | push-to-talk — Swift `fn-key-monitor` on macOS, `node-global-key-listener` elsewhere       |
| `recorder.ts` / `electron-recorder-transport.ts` | mic capture in a hidden renderer, streamed to main as 16 kHz mono Float32                  |
| `paster.ts` / `system-paster.ts`                 | text insertion — Swift `paste-helper` on macOS, `xdotool` / `wtype` / PowerShell elsewhere |
| `model-manager.ts` / `model-controller.ts`       | Whisper + LLM weight download, sha256 verification, load/unload                            |
| `storage.ts`                                     | app data directories                                                                       |
| `settings.ts`                                    | device-local settings, as an atomically-written JSON file                                  |
| `notifier.ts`                                    | native notifications                                                                       |
| `permissions.ts`                                 | microphone + accessibility grants                                                          |
| `core-worker.ts`                                 | spawns the Bare worker and is the typed RPC client                                         |

## Layout

```
bare/core-worker.mjs      The Bare worker: serves @opennib/core's HRPC contract.
src/
  main/                   Electron main. App lifecycle, adapters, IPC handlers,
                          the dictation pipeline wiring.
    ipc/                  One module per IPC surface (history, dictionary,
                          model, settings, onboarding, system).
    services/             The platform adapters listed above.
  preload/                Typed bridge exposing `window.opennib`. No logic.
  renderer/               UI — main window, tray popover, HUD, onboarding.
  shared/                 Types shared across the main/preload/renderer boundary.
native/                   macOS Swift helpers (sources; binaries are built).
resources/                Tray icon assets.
scripts/                  build-native.sh, build-tray-icon.mjs.
test/                     vitest suites for main-process services.
```

## Scripts

| Script                 | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| `npm run dev`          | electron-vite dev server with renderer HMR                       |
| `npm run build`        | build main + preload + renderer into `out/`                      |
| `npm run build:native` | compile the macOS Swift helpers (no-op on Windows/Linux)         |
| `npm run typecheck`    | `tsc --noEmit` for both the Node and the web project             |
| `npm test`             | vitest, including the real-worker integration tests              |
| `npm run format`       | Prettier                                                         |
| `npm run dist:mac`     | native helpers + build + electron-builder → `release/<version>/` |
| `npm run dist`         | the cross-platform variant (targets from the builder config)     |

## Native helpers (macOS only)

Two small Swift programs live in `native/`:

- `fn-key-monitor.swift` — global Fn-key listener. Apple's Fn key isn't
  visible to JS-level key listeners, so we shell out.
- `paste-helper.swift` — posts Cmd+V via `CGEvent`, which is markedly more
  stable on Apple Silicon than a userland automation library.

`npm run build:native` compiles both into universal (arm64 + x86_64)
binaries next to their sources. The output is git-ignored. In dev the main
process resolves them from `<repo>/native/`; in packaged builds
electron-builder places them in `Contents/Resources/native/`.

## Packaging

```sh
npm run dist:mac
```

Builds the helpers, runs `electron-vite build`, then invokes
`electron-builder` to produce an **unsigned** `.dmg` and `.zip` for the
host's architecture under `release/<version>/`. Unsigned means macOS
Gatekeeper will complain on first launch. Code signing and notarisation land
with v1.0. The app icon is `build/icon.png` (1024 px, the brand glyph on the
ink tile); electron-builder derives the `.icns` and `.ico` from it.

One build per architecture, on a matching host: the Bare runtime binary the
core worker runs on comes from a platform-specific optional dependency
(`bare-runtime-darwin-arm64`, `bare-runtime-darwin-x64`, …) and npm installs
only the host's. The builder config copies that package into the bundle
explicitly because electron-builder's dependency collector drops optional
dependencies; the app ships unarchived (`asar: false`) because Bare reads the
worker script and its imports straight off disk.

The bundle is trimmed the same way the SDK's own Electron Forge plugin trims
it: QVAC addons the worker never registers are excluded, and an `afterPack`
hook deletes every native prebuild that isn't for the target platform and
architecture. Untrimmed, the app directory is several gigabytes.

## Status and known limitations

- **macOS is the validated platform.** The full pipeline — hotkey, capture,
  transcription, cleanup, paste, history — runs end-to-end on Apple Silicon.
- **Windows and Linux are code-complete but not yet validated on real
  hosts.** The adapters and the NSIS / AppImage targets exist and typecheck;
  they have not been exercised on a real Win 10+ or Ubuntu desktop.
- **Wayland global hotkeys are not wired to the portal.** The X11 path works;
  on GNOME/KDE Wayland the hotkey may silently never fire.
- **No first-run check for `wtype` / `xdotool`.** Missing them surfaces as a
  spawn error rather than a helpful message.
- **Builds are unsigned** on every platform. One visible consequence on
  macOS: the paste helper is a separate binary that macOS does not attribute
  to the app, so it gets its **own** Accessibility entry. The first paste
  triggers the system prompt for it; if you decline or remove that entry,
  pasting silently stops until you re-enable "paste-helper" under
  System Settings → Privacy & Security → Accessibility. Developer ID signing
  (v1.0) collapses the two entries into one.
- **Models are downloaded on first use**, not bundled — the first launch
  needs a network connection and some patience. Nothing else ever does.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE).
