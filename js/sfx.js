/* Sound effects, synthesised with Web Audio: no audio files to load.
   Browsers only allow sound after a click, so ensure() is called from Play. */
(function (NP) {
  'use strict';

  class Sfx {
    constructor() {
      this.ctx = null;
      this.muted = false;
      this.noiseBuf = null;
    }

    ensure() {
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          this.ctx = new AC();
          const n = this.ctx.sampleRate;
          this.noiseBuf = this.ctx.createBuffer(1, n, n);
          const d = this.noiseBuf.getChannelData(0);
          for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) { this.ctx = null; }
    }

    get ready() { return !!this.ctx && !this.muted; }

    /* Filtered noise burst whose filter sweeps f0 → f1. */
    noise(dur, type, f0, f1, gain, delay) {
      if (!this.ready) return;
      const c = this.ctx, t = c.currentTime + (delay || 0);
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf;
      const flt = c.createBiquadFilter();
      flt.type = type;
      flt.Q.value = type === 'bandpass' ? 1.2 : 0.7;
      flt.frequency.setValueAtTime(f0, t);
      flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, dur / 4));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(flt).connect(g).connect(c.destination);
      src.start(t, Math.random() * 0.5);
      src.stop(t + dur + 0.05);
    }

    tone(freq0, freq1, dur, gain, type, delay) {
      if (!this.ready) return;
      const c = this.ctx, t = c.currentTime + (delay || 0);
      const o = c.createOscillator();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq0, t);
      o.frequency.exponentialRampToValueAtTime(freq1, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    slice() {
      this.noise(0.16, 'bandpass', 5200, 900, 0.35);
      this.noise(0.14, 'lowpass', 900, 200, 0.45, 0.04);
    }
    whiff() { this.noise(0.12, 'bandpass', 2600, 1400, 0.08); }
    miss() { this.tone(330, 196, 0.3, 0.12, 'triangle'); }
    bomb() {
      this.noise(0.7, 'lowpass', 900, 60, 0.7);
      this.tone(90, 40, 0.5, 0.35);
    }
    streak() {
      this.tone(880, 880, 0.12, 0.1);
      this.tone(1320, 1320, 0.18, 0.1, 'sine', 0.09);
    }
    tick() { this.tone(660, 660, 0.07, 0.08); }
    go() { this.tone(990, 990, 0.12, 0.1); }
    /* Wooden knock for a whacked mole. */
    bonk() {
      this.noise(0.09, 'lowpass', 1800, 300, 0.5);
      this.tone(240, 120, 0.12, 0.3, 'triangle');
    }
    bad() { this.tone(140, 110, 0.32, 0.12, 'sawtooth'); }
    good() {
      this.tone(660, 660, 0.1, 0.1);
      this.tone(880, 880, 0.12, 0.1, 'sine', 0.08);
      this.tone(1175, 1175, 0.16, 0.1, 'sine', 0.16);
    }
    win() {
      [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.16, 0.1, 'triangle', i * 0.09));
    }
    /* One tone per Simon tile. */
    note(freq) { this.tone(freq, freq, 0.32, 0.16, 'triangle'); }
  }

  NP.Sfx = Sfx;
})(window.NP);
