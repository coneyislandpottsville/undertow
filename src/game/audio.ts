/** Procedural water-rush bed. Unlocks on the first user gesture. */
export class RideAudio {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;

  unlock() {
    if (!this.ctx) this.build();
    void this.ctx?.resume();
  }

  private build() {
    const ctx = new AudioContext();
    const samples = Math.floor(ctx.sampleRate * 1.6);
    const buffer = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 0.7;
    filter.frequency.value = 420;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start();
    this.ctx = ctx;
    this.gain = gain;
    this.filter = filter;
  }

  update(speed: number, mode: "slide" | "whirl" | "paddle") {
    if (!this.ctx || !this.gain || !this.filter) return;
    const n =
      mode === "paddle" ? THREE_CLAMP(speed / 9, 0, 1) : THREE_CLAMP(speed / 44, 0, 1);
    const target = mode === "whirl" ? 0.07 + n * 0.08 : 0.018 + n * n * 0.2;
    const freq = mode === "whirl" ? 180 + n * 900 : 280 + n * 1900;
    const t = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(target, t, 0.08);
    this.filter.frequency.setTargetAtTime(freq, t, 0.12);
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}

function THREE_CLAMP(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
