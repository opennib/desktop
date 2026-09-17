import { resolve } from "node:path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

// `externalizeDepsPlugin` leaves every dependency declared in package.json out
// of the bundle, so `@opennib/core` and `@qvac/sdk` are loaded from
// node_modules at runtime rather than inlined. That is what we want: core's
// published dist is standard ESM with explicit `.js` extensions, and both
// packages reach native binaries (whisper/llama via the SDK, Hypercore's
// bindings) that must not be walked by Rollup.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      lib: { entry: "src/main/index.ts", formats: ["es"] },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: { entry: "src/preload/index.ts", formats: ["cjs"] },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          hud: resolve(__dirname, "src/renderer/hud.html"),
          tray: resolve(__dirname, "src/renderer/tray.html"),
          onboarding: resolve(__dirname, "src/renderer/onboarding.html"),
        },
      },
    },
  },
})
