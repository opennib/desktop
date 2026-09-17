import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DEFAULT_LANGUAGE, DEFAULT_WHISPER_MODEL_ID } from "@opennib/core"

import {
  DEFAULT_HOST_SETTINGS_SNAPSHOT,
  JsonFileSettings,
  parseHostSettingsSnapshot,
} from "../../../src/main/services/settings"

describe("JsonFileSettings", () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "opennib-settings-"))
    filePath = join(dir, "settings.json")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns defaults when the file does not exist", async () => {
    const s = new JsonFileSettings({ filePath })
    await s.load()
    expect(s.whisperModelId()).toBe(DEFAULT_WHISPER_MODEL_ID)
    expect(s.language()).toBe(DEFAULT_LANGUAGE)
    expect(s.cleanupEnabled()).toBe(false)
    expect(s.llmModelId()).toBeNull()
    expect(s.onboardingCompleted()).toBe(false)
    expect(s.enabled()).toBe(true)
  })

  it("applies the platform default hotkey when no file exists", async () => {
    const s = new JsonFileSettings({ filePath, defaultHotkey: "RightAlt" })
    await s.load()
    expect(s.hotkey()).toBe("RightAlt")
  })

  it("persists cleanupEnabled and llmModelId across reloads", async () => {
    const s = new JsonFileSettings({ filePath })
    await s.load()
    await s.setCleanupEnabled(true)
    await s.setLlmModelId("qwen2.5-0.5b-instruct-q4")

    const reloaded = new JsonFileSettings({ filePath })
    await reloaded.load()
    expect(reloaded.cleanupEnabled()).toBe(true)
    expect(reloaded.llmModelId()).toBe("qwen2.5-0.5b-instruct-q4")

    await reloaded.setLlmModelId(null)
    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as {
      llmModelId: string | null
    }
    expect(onDisk.llmModelId).toBeNull()
  })

  it("persists dictation and host fields in one combined blob", async () => {
    const s = new JsonFileSettings({ filePath })
    await s.load()
    await s.setLanguage("es")
    await s.setHotkey("F8")
    await s.setEnabled(false)

    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>
    // Both slices live in the same file so existing installs migrate for free.
    expect(onDisk).toMatchObject({
      language: "es",
      hotkey: "F8",
      enabled: false,
      whisperModelId: DEFAULT_WHISPER_MODEL_ID,
      cleanupEnabled: false,
      llmModelId: null,
    })

    const reloaded = new JsonFileSettings({ filePath })
    await reloaded.load()
    expect(reloaded.language()).toBe("es")
    expect(reloaded.hotkey()).toBe("F8")
    expect(reloaded.enabled()).toBe(false)
  })

  it("appSnapshot merges the dictation slice with the host slice", async () => {
    const s = new JsonFileSettings({ filePath })
    await s.load()
    await s.setWhisperModelId("medium")
    await s.setHotkeyMode("tap")
    expect(s.appSnapshot()).toMatchObject({
      whisperModelId: "medium",
      hotkeyMode: "tap",
    })
  })

  it("falls back to defaults for an unparseable file", async () => {
    await writeFile(filePath, "not json", "utf8")
    const s = new JsonFileSettings({ filePath })
    await s.load()
    expect(s.whisperModelId()).toBe(DEFAULT_WHISPER_MODEL_ID)
    expect(s.language()).toBe(DEFAULT_LANGUAGE)
  })

  it("loads previously persisted values", async () => {
    await writeFile(
      filePath,
      JSON.stringify({ whisperModelId: "small", language: "fr", hotkey: "F9" }),
      "utf8",
    )
    const s = new JsonFileSettings({ filePath })
    await s.load()
    expect(s.whisperModelId()).toBe("small")
    expect(s.language()).toBe("fr")
    expect(s.hotkey()).toBe("F9")
  })

  it("keeps the platform default hotkey when a legacy blob omits it", async () => {
    // A settings file predating the hotkey field must not clobber the
    // platform default with the parser's generic DEFAULT_HOTKEY fallback.
    await writeFile(filePath, JSON.stringify({ whisperModelId: "small" }), "utf8")
    const s = new JsonFileSettings({ filePath, defaultHotkey: "RightAlt" })
    await s.load()
    expect(s.hotkey()).toBe("RightAlt")
  })

  it("notifies core listeners when dictation values change", async () => {
    const s = new JsonFileSettings({ filePath })
    await s.load()
    const seen: string[] = []
    const off = s.onChange((snap) => seen.push(snap.language))
    await s.setLanguage("de")
    await s.setWhisperModelId("medium")
    off()
    await s.setLanguage("ja") // should NOT fire after off()
    expect(seen).toEqual(["de", "de"])
  })

  it("notifies app listeners for both dictation and host changes", async () => {
    const s = new JsonFileSettings({ filePath })
    await s.load()
    const seen: string[] = []
    s.onAppChange((snap) => seen.push(snap.hotkey))
    await s.setHotkey("F8")
    await s.setLanguage("de")
    expect(seen).toEqual(["F8", "F8"])
  })

  it("does not notify when the value is unchanged", async () => {
    const s = new JsonFileSettings({ filePath })
    await s.load()
    await s.setLanguage("de")
    let calls = 0
    s.onChange(() => calls++)
    await s.setLanguage("de")
    expect(calls).toBe(0)
  })

  it("throws if a dictation setter is called before load()", async () => {
    const s = new JsonFileSettings({ filePath })
    await expect(s.setLanguage("en")).rejects.toThrow(/before load/)
  })

  it("throws if a host setter is called before load()", async () => {
    const s = new JsonFileSettings({ filePath })
    await expect(s.setEnabled(false)).rejects.toThrow(/before load/)
  })

  it("persists onboardingCompleted across reloads", async () => {
    const s = new JsonFileSettings({ filePath })
    await s.load()
    expect(s.onboardingCompleted()).toBe(false)
    await s.setOnboardingCompleted(true)

    const reloaded = new JsonFileSettings({ filePath })
    await reloaded.load()
    expect(reloaded.onboardingCompleted()).toBe(true)
  })
})

describe("parseHostSettingsSnapshot", () => {
  it("returns host defaults for non-object input", () => {
    expect(parseHostSettingsSnapshot(null)).toEqual(DEFAULT_HOST_SETTINGS_SNAPSHOT)
    expect(parseHostSettingsSnapshot(undefined)).toEqual(DEFAULT_HOST_SETTINGS_SNAPSHOT)
    expect(parseHostSettingsSnapshot(42)).toEqual(DEFAULT_HOST_SETTINGS_SNAPSHOT)
  })

  it("falls back per field when a value is missing or the wrong type", () => {
    const result = parseHostSettingsSnapshot({ enabled: "yes", hotkey: "F8" })
    expect(result.hotkey).toBe("F8")
    expect(result.enabled).toBe(DEFAULT_HOST_SETTINGS_SNAPSHOT.enabled)
    expect(result.hotkeyMode).toBe(DEFAULT_HOST_SETTINGS_SNAPSHOT.hotkeyMode)
  })

  it("treats empty-string hotkey and selectedMicId as missing/null", () => {
    const result = parseHostSettingsSnapshot({ hotkey: "", selectedMicId: "" })
    expect(result.hotkey).toBe(DEFAULT_HOST_SETTINGS_SNAPSHOT.hotkey)
    expect(result.selectedMicId).toBeNull()
  })

  it("only accepts known hotkey modes", () => {
    expect(parseHostSettingsSnapshot({ hotkeyMode: "tap" }).hotkeyMode).toBe("tap")
    expect(parseHostSettingsSnapshot({ hotkeyMode: "nope" }).hotkeyMode).toBe("hold")
  })
})
