# Contributing to opennib desktop

Thanks for your interest in opennib — free, open-source, fully local
dictation.

**Where development happens:** opennib is currently developed in a private
monorepo (core + this desktop app + the Expo mobile app) while the apps are
prepared for release. This repository mirrors the desktop app. That means:

- **Issues and discussion are very welcome here** — bug reports, platform
  findings (especially Windows and Linux, which are not yet validated on real
  hosts), UX feedback.
- **Pull requests are hard for us to merge right now** — changes land in the
  private monorepo first and flow out with the next release. For anything
  larger than a typo, please open an issue first so the work isn't wasted.
- The full monorepo goes public as the project approaches v1.0, at which
  point normal PR flow opens up.

## Working on this app

Requirements: Node.js ≥ 22.17, npm. On macOS you also need the Xcode
command-line tools (`xcode-select --install`) for `swiftc`.

```sh
npm install
npm run build:native   # macOS only; a no-op elsewhere
npm run typecheck      # tsc --noEmit, Node project + web project
npm test               # vitest
npm run build          # electron-vite build → out/
npm run dev            # run the app with renderer HMR
npm run format         # Prettier
```

### Tests

`npm test` runs vitest over the main-process services. Four of those are
**real-worker integration tests**: they spawn the actual `bare` binary,
bind a unix socket, and round-trip the RPC contract against real Hypercore
stores in a temp directory. They never load model weights, so they stay fast
and offline.

Some sandboxes block `listen()` on a unix socket. If that bites locally:

```sh
OPENNIB_SKIP_WORKER_IT=1 npm test
```

CI runs them for real on macOS and Ubuntu.

## Ground rules for code in this repo

1. **No business logic in adapters.** Everything in `src/main/services/` is a
   translator between a platform API and an interface declared by
   [`@opennib/core`](https://github.com/opennib/core). Decisions, orchestration
   and state machines belong in core, not here. If a fix needs new logic, it
   probably needs a core release.
2. **Typed errors, never silent catches.** Domain failures use the
   `OpennibError` subclasses from `@opennib/core`. Every `catch` re-throws,
   converts to a typed error, or carries a comment explaining why swallowing
   is correct.
3. **No `console.log`.** Use `log.info` / `log.warn` / `log.error` /
   `log.debug` from `@opennib/core`.
4. **TypeScript strict, no `any`.** Narrow from `unknown`. Named exports only.
5. **The preload bridge stays thin.** It exposes a typed surface and nothing
   else; the renderer never reaches Node APIs.
6. **Rebuild the native helpers after touching `native/*.swift`** —
   `npm run build:native`. The compiled binaries are git-ignored, so a stale
   local build is the usual explanation for "the hotkey stopped working".
7. **Privacy is not negotiable.** No cloud calls, no telemetry, no
   third-party sync. Audio and transcripts stay on the device.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`, `build`).

## License

MIT. By contributing you agree your contributions are licensed under MIT.
