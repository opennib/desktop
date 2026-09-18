/**
 * electron-builder config for opennib desktop.
 *
 * macOS ships .dmg + .zip; Windows ships nsis; Linux ships AppImage. All
 * unsigned for now — code signing + notarisation come with v1.0.
 *
 * The two Swift helpers (fn-key-monitor, paste-helper) are mac-only and
 * land under `Contents/Resources/native/` via `mac.extraResources`. Win
 * and Linux drive their hotkey + paste through node-global-key-listener +
 * a system command (PowerShell SendKeys / xdotool / wtype), so they ship
 * no native helpers from this repo. Keeping the helpers in `mac.extraResources`
 * (instead of the top-level `extraResources`) means cross-OS builds don't
 * fail looking for Swift binaries that were never compiled.
 */
const { execFileSync } = require("child_process")
const fs = require("fs")
const path = require("path")

/**
 * QVAC native addons the desktop worker never registers. `bare/core-worker.mjs`
 * registers exactly two SDK plugins — whisper (`@qvac/transcription-whispercpp`)
 * and llama (`@qvac/llm-llamacpp`) — and the SDK core itself imports only
 * `@qvac/decoder-audio` (WAV decoding). Every other addon is reachable solely
 * through its own plugin module, so dropping it is safe. This mirrors the
 * "exclude unused addons" step of `@qvac/sdk/electron-forge`, the SDK's
 * official packaging plugin, for an electron-builder pipeline.
 */
const UNUSED_QVAC_ADDONS = [
  "bci-whispercpp",
  "classification-ggml",
  "diffusion-cpp",
  "embed-llamacpp",
  "ocr-ggml",
  "transcription-parakeet",
  "translation-nmtcpp",
  "tts-ggml",
  "vla-ggml",
]

/**
 * Runs after electron-builder has laid out the app directory (app files,
 * node_modules and extraResources all in place), before the DMG/zip/NSIS
 * targets are built.
 *
 * 1. Assert the two things the core worker cannot start without are in the
 *    bundle: `bare/core-worker.mjs` and the Bare runtime binary. The first
 *    0.1.0 DMG shipped without both and failed silently; this turns that
 *    into a build failure.
 * 2. Remove electron-builder's own copy of the runtime package, which it
 *    nests under `bare-runtime/node_modules/` as a "conflict dependency" —
 *    `files` negations do not reach those copies, and the top-level copy
 *    from `extraResources` is the one Node resolution finds once the nested
 *    one is gone.
 * 4. On macOS, give the whole bundle a stable ad-hoc signature (last, since
 *    it seals the bundle contents). Without a
 *    signing identity electron-builder skips signing and the app runs on
 *    Electron's stock binary, which is only "linker-signed": macOS
 *    identifies it as "Electron" with a hash shared by every Electron app
 *    of the same version and treats that identity as ephemeral, so
 *    Accessibility grants do not stick and the app keeps asking. A stable
 *    ad-hoc signature (`codesign --sign -`) gives it its own identifier,
 *    `com.opennib.desktop`. electron-builder signs AFTER this hook, so a
 *    Developer ID, once configured, simply overrides it.
 * 3. Delete every `prebuilds/<target>` directory whose target is not the
 *    one being built. Same rule as `@qvac/sdk/electron-forge`: keep entries
 *    whose name starts with `<platform>-<arch>` (the prefix match also keeps
 *    variants such as `linux-x64-musl`). The static `files` excludes skip
 *    foreign operating systems; this handles the same OS on the other arch,
 *    which a static glob cannot express per build.
 */
async function finalizeBundle(context) {
  const { Arch } = require("electron-builder")
  const platform = context.electronPlatformName
  const keepPrefix = `${platform}-${Arch[context.arch]}`
  const appDir = path.join(context.packager.getResourcesDir(context.appOutDir), "app")
  const nodeModules = path.join(appDir, "node_modules")

  const runtimePkg = `bare-runtime-${keepPrefix}`
  const runtimeBin = path.join(
    nodeModules,
    runtimePkg,
    "bin",
    platform === "win32" ? "bare.exe" : "bare",
  )
  const worker = path.join(appDir, "bare", "core-worker.mjs")
  for (const required of [worker, runtimeBin]) {
    if (!fs.existsSync(required)) {
      throw new Error(
        `bundle is missing ${path.relative(appDir, required)} — the core worker cannot start`,
      )
    }
  }
  fs.rmSync(path.join(nodeModules, "bare-runtime", "node_modules", runtimePkg), {
    recursive: true,
    force: true,
  })
  console.log(`  • verified ${runtimePkg} + bare/core-worker.mjs in bundle`)

  // node-global-key-listener spawns a bundled helper on Windows/Linux (and for
  // legacy macOS combos). npm strips the executable bit from those files, and
  // the library's fallback is an admin-password prompt to chmod them at
  // runtime. Set the bit at pack time instead.
  const keyServerBin = path.join(nodeModules, "node-global-key-listener", "bin")
  for (const name of ["X11KeyServer", "MacKeyServer"]) {
    const bin = path.join(keyServerBin, name)
    if (fs.existsSync(bin)) fs.chmodSync(bin, 0o755)
  }

  let removed = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name !== "prebuilds") {
        walk(full)
        continue
      }
      for (const target of fs.readdirSync(full, { withFileTypes: true })) {
        if (!target.isDirectory() || target.name.startsWith(keepPrefix)) continue
        fs.rmSync(path.join(full, target.name), { recursive: true, force: true })
        removed++
      }
    }
  }
  walk(nodeModules)
  console.log(`  • pruned ${removed} prebuild dirs not matching ${keepPrefix}`)

  // Must run LAST: the signature seals the bundle's contents, so any file
  // removed after signing invalidates it.
  if (platform === "darwin") {
    const appBundle = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
    )
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appBundle], { stdio: "inherit" })
    console.log("  • ad-hoc signed the app bundle (stable identity for macOS privacy grants)")
  }
}

module.exports = {
  // `electronVersion` is deliberately absent: electron-builder reads it from
  // the `electron` devDependency in this repo's own `node_modules`, so the
  // packaged runtime can never drift from the one `npm run dev` uses.
  appId: "com.opennib.desktop",
  productName: "opennib",
  copyright: "MIT — github.com/opennib",
  directories: {
    output: "release/${version}",
    buildResources: "build",
  },
  // `bare/` is the core worker script the main process spawns under Bare —
  // it is read straight off disk (see `asar: false` below), so it ships as a
  // plain app file next to `out/`.
  files: [
    "out/**/*",
    "bare/**/*",
    "package.json",
    ...UNUSED_QVAC_ADDONS.map((name) => `!node_modules/@qvac/${name}`),
    // Mobile prebuilds never belong in a desktop bundle.
    "!node_modules/**/prebuilds/android-*",
    "!node_modules/**/prebuilds/ios-*",
  ],
  afterPack: finalizeBundle,
  extraResources: [
    {
      from: "resources",
      to: "resources",
      filter: ["**/*"],
    },
  ],
  // Bare is a child runtime — embedded by `@qvac/sdk` for the AI engines, and
  // spawned directly by us for `bare/core-worker.mjs`. It reads the worker
  // entry plus every transitive import straight off disk and does NOT speak
  // Electron's asar archive, so the whole app ships unarchived. The cost
  // (slower cold start, more inodes on install) is negligible next to a
  // 1.4 GB AI-heavy bundle.
  asar: false,
  // The Bare binary itself lives in a platform-specific OPTIONAL dependency of
  // `bare-runtime` (`bare-runtime-<os>-<arch>`). electron-builder normally
  // copies it nested under `node_modules/bare-runtime/node_modules/` as a
  // "conflict dependency", but the first 0.1.0 DMG built from this tree
  // shipped without it and the app died at startup with "No binaries found
  // for target". Each OS block below therefore copies the package into the
  // bundle's top-level `node_modules` explicitly — the path Node resolution
  // reaches from `bare-runtime/index.js` — so dev and packaged runs share one
  // code path, and the `files` list drops the nested copy so the 70 MB
  // binary ships once. Only the host arch is installed by npm, hence one
  // build per arch on a matching host (the release workflow runs one runner
  // per arch).
  mac: {
    category: "public.app-category.utilities",
    files: ["!node_modules/**/prebuilds/linux-*", "!node_modules/**/prebuilds/win32-*"],
    // No explicit `arch`: build the host's arch. An x64 build on an arm64
    // host would ship without `bare-runtime-darwin-x64` (npm installs only the
    // host's optional runtime package) — build each arch on its own runner.
    target: ["dmg", "zip"],
    hardenedRuntime: false,
    gatekeeperAssess: false,
    extraResources: [
      { from: "native/fn-key-monitor", to: "native/fn-key-monitor" },
      { from: "native/paste-helper", to: "native/paste-helper" },
      {
        from: "node_modules/bare-runtime-darwin-${arch}",
        to: "app/node_modules/bare-runtime-darwin-${arch}",
      },
    ],
    extendInfo: {
      NSMicrophoneUsageDescription:
        "opennib records short audio clips while you hold the dictation key, transcribes them on-device with Whisper, and discards the audio.",
      NSAppleEventsUsageDescription:
        "opennib pastes the transcribed text into the focused application.",
    },
  },
  dmg: {
    artifactName: "opennib-${version}-${arch}.${ext}",
  },
  win: {
    target: ["nsis"],
    files: ["!node_modules/**/prebuilds/darwin-*", "!node_modules/**/prebuilds/linux-*"],
    extraResources: [
      {
        from: "node_modules/bare-runtime-win32-${arch}",
        to: "app/node_modules/bare-runtime-win32-${arch}",
      },
    ],
  },
  linux: {
    target: ["AppImage"],
    category: "Utility",
    files: ["!node_modules/**/prebuilds/darwin-*", "!node_modules/**/prebuilds/win32-*"],
    extraResources: [
      {
        from: "node_modules/bare-runtime-linux-${arch}",
        to: "app/node_modules/bare-runtime-linux-${arch}",
      },
    ],
  },
}
