/* Simulated Knight Board. Produces genuine 21/57-byte frames that go through
   the same parser, scaling and pipeline as real hardware, and understands the
   board's ASCII commands. Signal model (µV):
     1/f background + posterior alpha (eyes-closed reactive) + central beta
     + frontal eye blinks + jaw-clench EMG + mains interference (reduced by RLD)
     + per-channel DC offset and drift + evoked N1/P3 after stimuli
     + an occipital SSVEP at the frequency of the box being watched. */
(function (NP) {
  'use strict';
  const K = NP.KNIGHT;

  const W = {
    alpha: [0.15, 0.15, 0.35, 0.35, 0.7, 0.7, 1.0, 1.0],
    beta: [0.3, 0.3, 1.0, 1.0, 0.6, 0.6, 0.3, 0.3],
    blink: [1.0, 0.95, 0.3, 0.3, 0.1, 0.1, 0.05, 0.05],
    emg: [0.6, 0.6, 0.9, 0.9, 0.7, 0.7, 0.5, 0.5],
    n1: [0.8, 0.8, 1.0, 1.0, 0.6, 0.6, 0.3, 0.3],
    p3: [0.3, 0.3, 0.7, 0.7, 1.0, 1.0, 0.8, 0.8],
    ssvep: [0.05, 0.05, 0.1, 0.1, 0.55, 0.55, 1.0, 1.0],
    mu: [0.05, 0.05, 1.0, 1.0, 0.25, 0.25, 0.1, 0.1],
  };
  const DC = [220, -340, 150, 410, -90, 60, -260, 310];
  const DETACH_CH = 4;
  const SSVEP_UV = 2.5;

  function gaussian() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* Paul Kellet's refined pink-noise filter. */
  function pinkState() { return new Float64Array(7); }
  function pinkStep(b, white) {
    b[0] = 0.99886 * b[0] + white * 0.0555179;
    b[1] = 0.99332 * b[1] + white * 0.0750759;
    b[2] = 0.96900 * b[2] + white * 0.1538520;
    b[3] = 0.86650 * b[3] + white * 0.3104856;
    b[4] = 0.55000 * b[4] + white * 0.5329522;
    b[5] = -0.7616 * b[5] - white * 0.0168980;
    const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + white * 0.5362;
    b[6] = white * 0.115926;
    return out;
  }
  const PINK_SD = (() => {
    const b = pinkState();
    let s = 0, m = 0;
    const n = 40000, xs = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = pinkStep(b, gaussian()); m += xs[i]; }
    m /= n;
    for (let i = 0; i < n; i++) s += (xs[i] - m) ** 2;
    return Math.sqrt(s / n);
  })();

  class SimulatorSource {
    /* opts: {boardType, onFrame, onMarker, onCommandProgress} */
    constructor(opts) {
      this.kind = 'sim';
      this.opts = opts;
      this.fs = K.FS;
      this.parser = new NP.KnightParser(opts.boardType);
      this.queue = new NP.CommandQueue((cmd) => this.applyCommand(cmd), 120, opts.onCommandProgress);
      this.chOn = new Array(8).fill(false);
      this.chGain = new Array(8).fill(K.DEFAULT_GAIN);
      this.rld = new Array(8).fill(false);
      this.state = { eyesClosed: false, jaw: false, blinks: true, line: true, detach: false, autoStim: false, mi: false, ssvep: null };
      this.muPhase = Math.random() * 6.28;
      this.nextMi = -1;
      this.miCue = null;
      this.muGain = new Float64Array(8);
      this.betaGain = new Float64Array(8);
      this.ssvepEnv = 0;
      this.ssvepCur = null;
      this.pink = Array.from({ length: 8 }, pinkState);
      this.brown = new Float64Array(8);
      this.prevWhite = new Float64Array(8);
      this.alphaPhase = Math.random() * 6.28;
      this.betaPhase = Math.random() * 6.28;
      this.alphaEnv = 0.8; this.alphaTarget = 0.8;
      this.eyes = 0;
      this.jawLevel = 0;
      this.nextBlink = 3 * this.fs;
      this.blinkStart = -1e9;
      this.stimOnsets = [];
      this.nextStim = -1;
      this.counter = 0;
      this.emitted = 0;
      this.timer = null;
      this.uV = new Float64Array(8);
      this.imu = new Float32Array(9);
    }

    async start() {
      this.t0 = performance.now();
      this.emitted = 0;
      this.timer = setInterval(() => this.tick(), 20);
      return {};
    }

    async stop() {
      clearInterval(this.timer);
      this.timer = null;
      this.queue.cancel();
    }

    send(key, cmd) { this.queue.push(key, cmd); }

    setBoardType(t) { this.parser.setBoardType(t); }

    applyCommand(cmd) {
      let m;
      if ((m = /^chon_(\d)_(\d+)$/.exec(cmd))) { this.chOn[+m[1] - 1] = true; this.chGain[+m[1] - 1] = +m[2]; }
      else if ((m = /^choff_(\d)$/.exec(cmd))) this.chOn[+m[1] - 1] = false;
      else if ((m = /^rldadd_(\d)$/.exec(cmd))) this.rld[+m[1] - 1] = true;
      else if ((m = /^rldremove_(\d)$/.exec(cmd))) this.rld[+m[1] - 1] = false;
      return Promise.resolve();
    }

    /* Called by the app when a marker is placed, so the simulated brain responds. */
    notifyMarker(sampleIndex) { this.stimOnsets.push(sampleIndex); }

    tick() {
      const now = performance.now();
      let due = Math.floor(((now - this.t0) / 1000) * this.fs) - this.emitted;
      if (due <= 0) return;
      const cap = this.fs * 2;
      if (due > cap) {                 // tab was throttled: skip ahead instead of flooding
        this.t0 = now - ((this.emitted + cap) / this.fs) * 1000;
        due = cap;
      }
      const L = this.parser.frameLen;
      const bytes = new Uint8Array(due * L);
      const dv = new DataView(bytes.buffer);
      for (let n = 0; n < due; n++) this.writeFrame(dv, bytes, n * L, L);
      this.parser.feed(bytes, this.opts.onFrame);
    }

    writeFrame(dv, bytes, o, L) {
      const s = this.emitted, fs = this.fs, st = this.state, t = s / fs;

      if (st.autoStim) {
        if (this.nextStim < s) this.nextStim = s + Math.round(fs * (1.2 + Math.random() * 0.6));
        if (s === this.nextStim) {
          this.stimOnsets.push(s);
          if (this.opts.onMarker) this.opts.onMarker(s, 'stim');
          this.nextStim = s + Math.round(fs * (1.2 + Math.random() * 0.6));
        }
      }

      // Motor imagery: a left/right cue every 8 s. Imagining the hand movement
      // desynchronises mu and beta over the opposite hemisphere (C4 for left,
      // C3 for right, i.e. EXG4/EXG3 in the 10-20 spread labels) from ~0.5 to
      // 4 s, followed by a beta rebound (Pfurtscheller & Neuper, 2001).
      const muGain = this.muGain, betaGain = this.betaGain;
      muGain.fill(1);
      betaGain.fill(1);
      if (st.mi) {
        if (this.nextMi < s) this.nextMi = s + Math.round(2 * fs);
        if (s === this.nextMi) {
          const side = Math.random() < 0.5 ? 'left' : 'right';
          this.miCue = { s, side };
          if (this.opts.onMarker) this.opts.onMarker(s, side);
          this.nextMi = s + Math.round(8 * fs);
        }
      }
      if (this.miCue) {
        const tm = (s - this.miCue.s) / fs;
        const ramp = (a, b) => Math.max(0, Math.min(1, (tm - a) / (b - a)));
        const erd = ramp(0.3, 1.0) * (1 - ramp(3.8, 4.5));
        const rebound = ramp(4.3, 4.8) * (1 - ramp(5.5, 6.5));
        const contra = this.miCue.side === 'left' ? 3 : 2, ipsi = contra === 3 ? 2 : 3;
        muGain[contra] = 1 - 0.55 * erd;
        muGain[ipsi] = 1 - 0.15 * erd;
        betaGain[contra] = (1 - 0.45 * erd) * (1 + 0.8 * rebound);
        if (tm > 7) this.miCue = null;
      }
      this.muPhase += (2 * Math.PI * 10.8) / fs;

      // Slowly varying shared generators
      if (s % Math.round(fs * 0.7) === 0) this.alphaTarget = 0.55 + Math.random() * 0.45;
      this.alphaEnv += (this.alphaTarget - this.alphaEnv) * 0.01;
      this.eyes += ((st.eyesClosed ? 1 : 0) - this.eyes) / (0.4 * fs);
      this.jawLevel += ((st.jaw ? 1 : 0) - this.jawLevel) / (0.08 * fs);
      const alphaF = 10.2 + 0.15 * Math.sin(2 * Math.PI * 0.1 * t);
      this.alphaPhase += (2 * Math.PI * alphaF) / fs;
      this.betaPhase += (2 * Math.PI * 20.5) / fs;
      // Attending a flickering box desynchronises posterior alpha (ERD, ~60% drop).
      const alphaErd = 1 - 0.6 * this.ssvepEnv;
      const alpha = (4 + 26 * this.eyes) * this.alphaEnv * alphaErd * Math.sin(this.alphaPhase);
      const beta = 1.5 * Math.sin(this.betaPhase);
      const mu = 6 * this.alphaEnv * Math.sin(this.muPhase);

      let blink = 0;
      if (st.blinks && this.eyes < 0.5 && s >= this.nextBlink) {
        this.blinkStart = s;
        this.nextBlink = s + Math.round(fs * (2.5 + Math.random() * 4));
      }
      const bt = (s - this.blinkStart) / fs;
      if (bt >= 0 && bt < 0.35) blink = 160 * Math.pow(Math.sin(Math.PI * bt / 0.35), 2);

      let n1 = 0, p3 = 0;
      for (let k = this.stimOnsets.length - 1; k >= 0; k--) {
        const dt = (s - this.stimOnsets[k]) / fs;
        if (dt > 1.0) { this.stimOnsets.splice(k, 1); continue; }
        if (dt < 0) continue;
        n1 += -5 * Math.exp(-(((dt - 0.1) / 0.03) ** 2));
        p3 += 9 * Math.exp(-(((dt - 0.35) / 0.08) ** 2));
      }

      // SSVEP: fundamental + 2 harmonics, starting 140 ms after the watched
      // box begins to flicker and building up over ~250 ms.
      const sv = st.ssvep;
      if (sv) this.ssvepCur = sv;
      this.ssvepEnv += ((sv ? 1 : 0) - this.ssvepEnv) / (0.2 * fs);
      let ssvep = 0;
      const cur = this.ssvepCur;
      if (cur && this.ssvepEnv > 1e-3) {
        const tr = (s - cur.onset) / fs - 0.14;
        if (tr > 0) {
          const a1 = SSVEP_UV * (cur.gain || 1) * Math.max(0.5, 1 - (cur.f - 8) / 20);
          ssvep = a1 * this.ssvepEnv * Math.min(1, tr / 0.25) * (
            Math.sin(2 * Math.PI * cur.f * tr + cur.phase) +
            0.45 * Math.sin(2 * Math.PI * 2 * cur.f * tr + 2 * cur.phase + 0.8) +
            0.2 * Math.sin(2 * Math.PI * 3 * cur.f * tr + 3 * cur.phase + 1.6));
        }
      }

      const mains = st.line ? Math.sin(2 * Math.PI * 60 * t) : 0;
      let loffP = 0, loffN = 0;

      bytes[o] = K.START;
      bytes[o + 1] = this.counter;
      for (let c = 0; c < 8; c++) {
        let counts = 0;
        if (this.chOn[c]) {
          const white = gaussian();
          const bg = 6 * pinkStep(this.pink[c], white) / PINK_SD;
          this.brown[c] = 0.996 * this.brown[c] + 0.35 * gaussian();
          const emgWhite = gaussian();
          const emg = this.jawLevel * 45 * W.emg[c] * (emgWhite - this.prevWhite[c]) / Math.SQRT2;
          this.prevWhite[c] = emgWhite;
          const line = mains * (this.rld[c] ? 1.5 : 20) * (1 + 0.05 * c);
          const drift = 30 * Math.sin(2 * Math.PI * 0.05 * t + c);
          let uv = DC[c] + drift + bg + this.brown[c] + alpha * W.alpha[c] + beta * W.beta[c] * betaGain[c] + mu * W.mu[c] * muGain[c] +
            blink * W.blink[c] + emg + line + n1 * W.n1[c] + p3 * W.p3[c] + ssvep * W.ssvep[c];
          const scale = K.uvPerCount(this.chGain[c]);
          if (st.detach && c === DETACH_CH) {
            uv = K.rangeUv(this.chGain[c]) * (0.999 + 0.001 * Math.random());
            loffP |= 1 << c; loffN |= 1 << c;
          }
          counts = Math.max(-32768, Math.min(32767, Math.round(uv / scale)));
        }
        dv.setInt16(o + 2 + 2 * c, counts, false);
      }
      bytes[o + 18] = loffP;
      bytes[o + 19] = loffN;

      if (L === K.FRAME_LEN.imu) {
        const imu = this.imu;
        const jaw = this.jawLevel;
        imu[0] = 0.25 * Math.sin(2 * Math.PI * 0.2 * t) + 0.02 * gaussian() + 0.3 * jaw * gaussian();
        imu[1] = 0.15 * Math.sin(2 * Math.PI * 0.13 * t + 1) + 0.02 * gaussian() + 0.3 * jaw * gaussian();
        imu[2] = 9.81 + 0.02 * gaussian() + 0.2 * jaw * gaussian();
        imu[3] = 0.01 * gaussian() + 0.08 * jaw * gaussian();
        imu[4] = 0.01 * gaussian() + 0.08 * jaw * gaussian();
        imu[5] = 0.03 * Math.cos(2 * Math.PI * 0.2 * t) + 0.01 * gaussian();
        imu[6] = 22 + 0.3 * gaussian();
        imu[7] = -4 + 0.3 * gaussian();
        imu[8] = 41 + 0.3 * gaussian();
        for (let k = 0; k < 9; k++) dv.setFloat32(o + 20 + 4 * k, imu[k], true);
      }
      bytes[o + L - 1] = K.END;

      this.counter = (this.counter + 1) & 0xFF;
      this.emitted++;
    }
  }

  NP.SimulatorSource = SimulatorSource;
})(window.NP);
