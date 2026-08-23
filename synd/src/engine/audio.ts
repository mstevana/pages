// Procedural audio: synthesized SFX + generative dark-ambient bed + rain.
// Everything is built from oscillators and filtered noise; no audio files.

import { ItemType } from "../game/items";

export class AudioEngine {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private rainSrc: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private padTimer = 0;
  muted = false;

  // must be called from a user gesture
  unlock(): void {
    if (this.ac) {
      if (this.ac.state === "suspended") void this.ac.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ac = new AC();
    this.master = this.ac.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ac.destination);
    const len = this.ac.sampleRate * 2;
    this.noiseBuf = this.ac.createBuffer(1, len, this.ac.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ac) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ac.currentTime, 0.05);
  }

  private noise(dur: number, filterHz: number, gain: number, decay: number, type: BiquadFilterType = "lowpass"): void {
    if (!this.ac || !this.master || !this.noiseBuf) return;
    const t = this.ac.currentTime;
    const src = this.ac.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ac.createBiquadFilter();
    f.type = type; f.frequency.value = filterHz;
    const g = this.ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + dur);
  }

  private tone(freq0: number, freq1: number, dur: number, gain: number, type: OscillatorType = "square"): void {
    if (!this.ac || !this.master) return;
    const t = this.ac.currentTime;
    const o = this.ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freq1), t + dur);
    const g = this.ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur);
  }

  shoot(w: ItemType): void {
    switch (w) {
      case "gun": this.noise(0.14, 1400, 0.5, 0.12); this.tone(220, 60, 0.1, 0.25); break;
      case "uzi": this.noise(0.07, 2200, 0.3, 0.06); break;
      case "minigun": this.noise(0.06, 2600, 0.28, 0.05); this.tone(160, 120, 0.05, 0.1, "sawtooth"); break;
      case "shotgun": this.noise(0.3, 900, 0.7, 0.26); this.tone(120, 40, 0.2, 0.3); break;
      case "laser": this.tone(2400, 300, 0.22, 0.3, "sawtooth"); break;
      case "gauss": this.tone(60, 30, 0.5, 0.8, "sine"); this.noise(0.5, 500, 0.7, 0.45); break;
      default: break;
    }
  }

  explosion(): void {
    this.noise(0.8, 400, 0.9, 0.7);
    this.tone(90, 25, 0.7, 0.7, "sine");
  }
  hit(): void { this.noise(0.08, 800, 0.3, 0.07); }
  die(): void { this.tone(300, 60, 0.4, 0.25, "sawtooth"); }
  persuade(): void {
    this.tone(400, 1400, 0.35, 0.25, "sine");
    this.tone(600, 1800, 0.35, 0.18, "sine");
  }
  pickup(): void { this.tone(700, 1200, 0.12, 0.2, "square"); }
  drop(): void { this.tone(500, 250, 0.1, 0.15, "square"); }
  click(): void { this.tone(900, 700, 0.05, 0.12, "square"); }
  medkit(): void { this.tone(500, 900, 0.3, 0.2, "sine"); }
  carStart(): void { this.tone(80, 160, 0.5, 0.3, "sawtooth"); }
  objective(): void { this.tone(523, 523, 0.12, 0.2, "square"); this.tone(784, 784, 0.3, 0.2, "square"); }
  fail(): void { this.tone(300, 80, 1.0, 0.3, "sawtooth"); }

  rain(on: boolean): void {
    if (!this.ac || !this.master || !this.noiseBuf) return;
    if (on && !this.rainSrc) {
      this.rainSrc = this.ac.createBufferSource();
      this.rainSrc.buffer = this.noiseBuf;
      this.rainSrc.loop = true;
      const f = this.ac.createBiquadFilter();
      f.type = "bandpass"; f.frequency.value = 3000; f.Q.value = 0.4;
      this.rainGain = this.ac.createGain();
      this.rainGain.gain.value = 0.04;
      this.rainSrc.connect(f).connect(this.rainGain).connect(this.master);
      this.rainSrc.start();
    } else if (!on && this.rainSrc) {
      this.rainSrc.stop();
      this.rainSrc = null;
    }
  }

  // Call every frame; occasionally emits a slow detuned pad note.
  ambient(dt: number): void {
    if (!this.ac || !this.master) return;
    this.padTimer -= dt;
    if (this.padTimer > 0) return;
    this.padTimer = 5 + Math.random() * 7;
    const roots = [55, 65.4, 49, 73.4];
    const root = roots[(Math.random() * roots.length) | 0];
    for (const mul of [1, 1.5, 2.02]) {
      const t = this.ac.currentTime;
      const o = this.ac.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = root * mul;
      const f = this.ac.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(200, t);
      f.frequency.linearRampToValueAtTime(700, t + 3);
      f.frequency.linearRampToValueAtTime(150, t + 7);
      const g = this.ac.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.045, t + 2.5);
      g.gain.linearRampToValueAtTime(0, t + 7);
      o.connect(f).connect(g).connect(this.master);
      o.start(t); o.stop(t + 7.2);
    }
  }
}
