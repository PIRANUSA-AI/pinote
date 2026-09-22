const FRAME_SAMPLES = 1600

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Int16Array(FRAME_SAMPLES)
    this.offset = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const channel = input[0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      const clamped = Math.max(-1, Math.min(1, channel[i]))
      this.buffer[this.offset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      this.offset += 1

      if (this.offset === FRAME_SAMPLES) {
        const copy = new Int16Array(this.buffer)
        this.port.postMessage(copy.buffer, [copy.buffer])
        this.offset = 0
      }
    }

    return true
  }
}

registerProcessor('pcmProcessor', PcmProcessor)
