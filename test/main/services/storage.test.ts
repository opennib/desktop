import { describe, expect, it } from "vitest"

import { ElectronStorage } from "../../../src/main/services/storage"

describe("ElectronStorage", () => {
  it("returns the userData directory from the injected app", () => {
    const storage = new ElectronStorage({
      getPath: (name) => {
        if (name !== "userData") throw new Error("unexpected name")
        return "/Users/example/Library/Application Support/opennib"
      },
    })
    expect(storage.baseDirectory()).toBe("/Users/example/Library/Application Support/opennib")
  })

  it("normalizes Windows backslashes to forward slashes", () => {
    const storage = new ElectronStorage({
      getPath: () => "C:\\Users\\example\\AppData\\Roaming\\opennib",
    })
    expect(storage.baseDirectory()).toBe("C:/Users/example/AppData/Roaming/opennib")
  })
})
