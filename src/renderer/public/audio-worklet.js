// AudioWorklet that captures the live mic input as Float32 PCM and ships
// frames back to the main thread. Loaded via audioWorklet.addModule() from
// renderer/recorder.ts; not bundled by Vite (lives under public/).

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.recording = false

    this.port.onmessage = (event) => {
      if (event.data === "start") {
        this.recording = true
      } else if (event.data === "stop") {
        this.recording = false
      }
    }
  }

  process(inputs) {
    if (!this.recording) return true

    const input = inputs[0]
    if (input && input[0]) {
      const samples = new Float32Array(input[0])
      this.port.postMessage(samples.buffer, [samples.buffer])
    }
    return true
  }
}

registerProcessor("pcm-capture", PCMCaptureProcessor)
