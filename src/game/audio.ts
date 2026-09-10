type Mode = "slide" | "whirl" | "paddle";

export type SplashPart = "impact" | "column" | "ring" | "drop";

type Layer = { filter: BiquadFilterNode; gain: GainNode };

type OneShot = {
  type: BiquadFilterType;
  from: number;
  to: number;
  q: number;
  peak: number;
  attack: number;
  decay: number;
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const MUFFLE_OPEN = 20000;
const MUFFLE_SHUT = 380;

export class RideAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private rumble: Layer | null = null;
  private hiss: Layer | null = null;
  private roar: (Layer & { lfo: OscillatorNode; depth: GainNode }) | null = null;
  private under: Layer | null = null;
  private muffle: BiquadFilterNode | null = null;
  private submerged = 0;

  unlock() {
    if (!this.ctx) this.build();
    void this.ctx?.resume();
  }

  private build() {
    const ctx = new AudioContext();
    const samples = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buffer;
    const master = ctx.createGain();
    master.gain.value = 0.55;
    const muffle = ctx.createBiquadFilter();
    muffle.type = "lowpass";
    muffle.frequency.value = MUFFLE_OPEN;
    muffle.Q.value = 0.4;
    master.connect(muffle);
    muffle.connect(ctx.destination);
    this.muffle = muffle;
    this.ctx = ctx;
    this.master = master;
    this.rumble = this.layer("lowpass", 220, 0.8);
    this.hiss = this.layer("bandpass", 1400, 0.6);
    const roar = this.layer("lowpass", 160, 1.1);
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 1.5;
    const depth = ctx.createGain();
    depth.gain.value = 0;
    lfo.connect(depth);
    depth.connect(roar.gain.gain);
    lfo.start();
    this.roar = { ...roar, lfo, depth };
    this.under = this.layer("lowpass", 380, 0.7);
  }

  private layer(type: BiquadFilterType, freq: number, q: number): Layer {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);
    src.start();
    return { filter, gain };
  }

  setSubmerged(amount: number) {
    this.submerged = amount;
    if (!this.ctx || !this.muffle || !this.master) return;
    const t = this.ctx.currentTime;
    this.muffle.frequency.setTargetAtTime(
      MUFFLE_OPEN * Math.pow(MUFFLE_SHUT / MUFFLE_OPEN, amount),
      t,
      0.05,
    );
    this.master.gain.setTargetAtTime(0.55 * (1 - 0.3 * amount), t, 0.06);
  }

  update(speed: number, mode: Mode, spin = 0, churn = 0) {
    if (!this.ctx || !this.rumble || !this.hiss || !this.roar || !this.under) return;
    const t = this.ctx.currentTime;
    const v = clamp(Math.abs(speed) / 44, 0, 1);
    const p = clamp(Math.abs(speed) / 9, 0, 1);
    const sliding = mode === "slide";
    const paddling = mode === "paddle";
    const rumbleGain = sliding ? 0.05 + v * 0.35 : paddling ? 0.02 + p * 0.06 : 0.04;
    const hissGain = sliding
      ? v * v * 0.24 + churn * 0.12
      : (paddling ? p * 0.05 : 0.02) + churn * 0.14;
    this.rumble.gain.gain.setTargetAtTime(rumbleGain, t, 0.08);
    this.rumble.filter.frequency.setTargetAtTime(160 + v * 340, t, 0.1);
    this.hiss.gain.gain.setTargetAtTime(hissGain, t, 0.08);
    this.hiss.filter.frequency.setTargetAtTime(900 + v * 2600 + churn * 900, t, 0.12);
    const whirl = mode === "whirl";
    const s = clamp(spin / 3.6, 0, 1);
    const roarGain = whirl ? 0.12 + s * 0.18 : 0;
    this.roar.gain.gain.setTargetAtTime(roarGain, t, 0.15);
    this.roar.depth.gain.setTargetAtTime(whirl ? roarGain * 0.6 : 0, t, 0.15);
    this.roar.lfo.frequency.setTargetAtTime(0.6 + spin * 0.45, t, 0.2);
    this.roar.filter.frequency.setTargetAtTime(120 + s * 260, t, 0.2);
    this.under.gain.gain.setTargetAtTime(this.submerged * 0.2, t, 0.12);
    this.under.filter.frequency.setTargetAtTime(300 + v * 260, t, 0.2);
  }

  plunge() {
    this.oneShot({ type: "lowpass", from: 1800, to: 110, q: 0.9, peak: 0.75, attack: 0.015, decay: 0.5 });
  }

  breach() {
    this.oneShot({ type: "bandpass", from: 700, to: 2600, q: 0.8, peak: 0.42, attack: 0.01, decay: 0.3 });
  }

  splashPart(part: SplashPart, pitch = 1) {
    if (part === "impact") {
      this.oneShot({ type: "lowpass", from: 2600, to: 240, q: 0.7, peak: 0.9, attack: 0.01, decay: 0.7 });
    } else if (part === "column") {
      this.oneShot({ type: "bandpass", from: 380, to: 1500, q: 0.8, peak: 0.42, attack: 0.05, decay: 0.4 });
    } else if (part === "ring") {
      this.oneShot({ type: "lowpass", from: 900, to: 150, q: 0.9, peak: 0.36, attack: 0.03, decay: 0.9 });
    } else {
      this.oneShot({
        type: "bandpass",
        from: 850 * pitch,
        to: 2400 * pitch,
        q: 3.4,
        peak: 0.13,
        attack: 0.004,
        decay: 0.1,
      });
    }
  }

  stroke() {
    this.oneShot({ type: "bandpass", from: 500, to: 900, q: 1.2, peak: 0.28, attack: 0.02, decay: 0.16 });
  }

  whoosh() {
    this.oneShot({ type: "bandpass", from: 260, to: 2400, q: 0.9, peak: 0.55, attack: 0.05, decay: 0.75 });
  }

  private oneShot(p: OneShot) {
    if (!this.ctx || !this.noise || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const end = t + p.attack + p.decay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = p.type;
    filter.Q.value = p.q;
    filter.frequency.setValueAtTime(p.from, t);
    filter.frequency.exponentialRampToValueAtTime(p.to, end);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(p.peak, t + p.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t);
    src.stop(end + 0.05);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
