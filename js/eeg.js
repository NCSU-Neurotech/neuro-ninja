/* EEG side of Neuro Ninja: connects to the Knight Board (or the simulator),
   keeps the raw µV history, rates each channel's signal, and turns the last
   few seconds of EEG into "which tile is being looked at".

   The connection, packet parser, simulator and decoder are copied unchanged
   from EXG Visualizer+ (js/lib), where FBCCA scored 92% and 100% on a real
   Knight Board. Decoding follows that app's Free mode: every 250 ms the
   newest window is scored, and a tile is picked once it has led by a clear
   margin for HOLD_S. */
(function (NP) {
  'use strict';
  const K = NP.KNIGHT;
  const M = NP.ssvepMethods;

  const HISTORY_S = 30;
  const TICK_MS = 250;
  const HOLD_S = 0.75;          // dwell rule against false picks (as in EXG Visualizer+)
  const MARGIN = 0.12;          // winner must lead the runner-up by 12% of its score
  // After a pick the window still holds the old gaze. The picked tile is
  // empty by then and empty tiles can't be picked, so this can be shorter
  // than EXG Visualizer+'s 1 s.
  const REFRACTORY_MS = 600;
  const QUALITY_MS = 500;

  class EegEngine {
    constructor() {
      this.fs = K.FS;
      this.raw = Array.from({ length: 8 }, () => new NP.RingBuffer(HISTORY_S * K.FS));
      this.loff = new NP.RingBuffer(HISTORY_S * K.FS, Uint16Array);
      this.total = 0;
      this.source = null;
      this.connected = false;
      this.busy = false;
      this.cfg = { chans: [4, 5, 6, 7], gain: 4, rld: true, boardType: 'knight' };
      this.chGain = new Array(8).fill(K.DEFAULT_GAIN);
      this.chBoardOn = new Array(8).fill(false);
      this.lastCounter = -1;
      this.dropped = 0;
      this.pending = 0;
      this.quality = new Array(8).fill(null);
      this.lastQuality = 0;
      this.dec = null;
      this.simGaze = -1;
      this.onChange = () => {};
      this.onClosed = () => {};
    }

    get kind() { return this.source ? this.source.kind : null; }

    /* ---------------- connection ---------------- */
    async connect({ kind, port, path }) {
      if (this.connected || this.busy) return;
      this.busy = true;
      const opts = {
        boardType: this.cfg.boardType,
        onFrame: (f) => this.onFrame(f),
        onError: (err) => console.warn('[serial]', err),
        onClosed: (err) => this.handleClosed(err),
        onCommandProgress: (pending, cmd, err) => this.onCommand(pending, cmd, err),
      };
      let src;
      if (kind === 'sim') src = new NP.SimulatorSource(opts);
      else if (path) src = new NP.KnightBridgeSource(Object.assign(opts, { path }));
      else src = new NP.KnightSerialSource(Object.assign(opts, { port: port || null }));
      if (kind === 'sim') src.state.blinks = true;
      try {
        await src.start();
      } finally {
        this.busy = false;
      }
      this.reset();
      this.fs = src.fs;
      this.source = src;
      this.connected = true;
      this.applyConfig();
      this.onChange();
    }

    async disconnect() {
      const src = this.source;
      this.stopDecoding();
      this.source = null;
      this.connected = false;
      if (src) { this.busy = true; try { await src.stop(); } finally { this.busy = false; } }
      this.onChange();
    }

    handleClosed(err) {
      this.stopDecoding();
      this.source = null;
      this.connected = false;
      this.onClosed(err);
      this.onChange();
    }

    reset() {
      this.raw.forEach((r) => r.clear());
      this.loff.clear();
      this.total = 0;
      this.lastCounter = -1;
      this.dropped = 0;
      this.chGain.fill(K.DEFAULT_GAIN);
      this.chBoardOn.fill(false);
      this.quality.fill(null);
    }

    /* Switch on the decoding channels at the chosen gain, with RLD. Other
       channels are left alone: each command takes 2 s on the real board. */
    applyConfig() {
      const s = this.source;
      if (!s) return;
      for (const c of this.cfg.chans) {
        s.send(`ch${c}`, K.cmd.on(c, this.cfg.gain));
        s.send(`rld${c}`, this.cfg.rld ? K.cmd.rldOn(c) : K.cmd.rldOff(c));
      }
    }

    setConfig(patch) {
      const before = JSON.stringify(this.cfg);
      Object.assign(this.cfg, patch);
      if (patch.boardType && this.source) this.source.setBoardType(patch.boardType);
      if (JSON.stringify(this.cfg) !== before && this.connected) this.applyConfig();
      this.onChange();
    }

    onCommand(pending, cmd, err) {
      const on = cmd && /^chon_(\d)_(\d+)$/.exec(cmd);
      if (on) { this.chGain[+on[1] - 1] = +on[2]; this.chBoardOn[+on[1] - 1] = true; }
      const off = cmd && /^choff_(\d)$/.exec(cmd);
      if (off) this.chBoardOn[+off[1] - 1] = false;
      this.pending = pending;
      this.commandError = err ? err.message : '';
      this.onChange();
    }

    get configuring() { return !!(this.source && (this.pending > 0 || this.source.queue.running)); }

    onFrame(f) {
      if (this.lastCounter >= 0) {
        const gap = (f.counter - this.lastCounter - 1 + 256) & 0xFF;
        for (let g = 0; g < gap; g++) {
          for (let c = 0; c < 8; c++) this.raw[c].push(NaN);
          this.loff.push(0);
          this.total++;
        }
        this.dropped += gap;
      }
      this.lastCounter = f.counter;
      for (let c = 0; c < 8; c++) {
        // Zeros from a channel the board hasn't switched on yet are "no data".
        const v = f.counts[c];
        this.raw[c].push(v !== 0 || this.chBoardOn[c] ? v * K.uvPerCount(this.chGain[c]) : NaN);
      }
      this.loff.push(f.loffP | (f.loffN << 8));
      this.total++;
    }

    /* ---------------- signal quality ---------------- */
    /* Per channel over the last 2 s: no data, railed (pinned at the edge of
       the range), flat, or OK. Lead-off is only a warning: the docs don't
       say which way round the bits are. */
    updateQuality(force) {
      const now = performance.now();
      if (!force && now - this.lastQuality < QUALITY_MS) return this.quality;
      this.lastQuality = now;
      const n = Math.min(this.raw[0].count, 2 * this.fs);
      for (let c = 0; c < 8; c++) {
        if (!this.cfg.chans.includes(c)) { this.quality[c] = null; continue; }
        if (n < this.fs / 2) { this.quality[c] = { ok: false, state: 'nodata', text: this.connected ? 'Waiting' : 'Not connected' }; continue; }
        const x = this.raw[c].copyLast(n);
        let cnt = 0, sum = 0, peak = 0;
        for (let i = 0; i < n; i++) { const v = x[i]; if (Number.isFinite(v)) { cnt++; sum += v; if (Math.abs(v) > peak) peak = Math.abs(v); } }
        if (cnt < n / 2) { this.quality[c] = { ok: false, state: 'nodata', text: this.chBoardOn[c] ? 'No data' : 'Starting…' }; continue; }
        const mean = sum / cnt;
        let ss = 0;
        for (let i = 0; i < n; i++) if (Number.isFinite(x[i])) ss += (x[i] - mean) ** 2;
        const sd = Math.sqrt(ss / cnt);
        const range = K.rangeUv(this.chGain[c]);
        let offN = 0, seen = 0;
        for (let a = 0; a < Math.min(this.loff.count, this.fs); a++) { seen++; if (this.loff.at(a) & ((1 << c) | (1 << (c + 8)))) offN++; }
        const leadOff = seen > 0 && offN / seen > 0.5;
        if (peak >= 0.97 * range) this.quality[c] = { ok: false, state: 'railed', text: 'Railed: lower the gain or reseat' };
        else if (sd < 0.3) this.quality[c] = { ok: false, state: 'flat', text: 'Flat: check the wire' };
        else if (leadOff) this.quality[c] = { ok: true, state: 'warn', text: 'Lead off?' };
        else this.quality[c] = { ok: true, state: 'ok', text: 'OK' };
      }
      return this.quality;
    }

    get usableChans() {
      this.updateQuality();
      return this.cfg.chans.filter((c) => this.quality[c] && this.quality[c].ok);
    }

    /* ---------------- decoding ---------------- */
    /* targets: [{f, phase}]. Picks are reported through onPick(k). All
       targets are always scored, so the margin is measured against every
       flickering tile, but only tiles isLive(k) says hold something can be
       picked: looking at an empty tile does nothing, and the lag of the
       window after a slice can't fire a pick on the tile just emptied. */
    /* calib (optional, from a Calibrate run): each target's score is then
       measured against its own resting level, as a z-score, before any
       decision. onScores (optional) receives every window's raw scores. */
    startDecoding({ targets, windowS, lineFreq, onPick, onAim, isLive, calib, onScores }) {
      this.dec = {
        targets, windowS, lineFreq: lineFreq || 0, onPick, onAim: onAim || (() => {}), isLive: isLive || (() => true),
        calib: calib || null, onScores: onScores || null,
        fLow: Math.min(...targets.map((t) => t.f)),
        startTotal: this.total, dwell: { k: -1, n: 0 }, refractoryUntil: 0, lock: { k: -1, until: 0 }, last: null,
        need: Math.max(1, Math.round((HOLD_S * 1000) / TICK_MS)),
        lastTick: 0,
      };
    }

    stopDecoding() {
      this.dec = null;
      this.setSimGaze(-1);
    }

    /* The flicker restarted (after a pause): wait for a fresh window. */
    restartWindow() {
      if (!this.dec) return;
      this.dec.startTotal = this.total;
      this.dec.dwell = { k: -1, n: 0 };
      this.dec.last = null;
    }

    /* Called right after a frame is drawn, so the work lands at the start of
       a frame interval and can't push the next flicker frame back. */
    maybeTick(now) {
      const d = this.dec;
      if (!d || now - d.lastTick < TICK_MS) return;
      d.lastTick = now;
      setTimeout(() => this.tick(now), 0);
    }

    tick(now) {
      const d = this.dec;
      if (!d || !this.connected) return;
      const fs = this.fs, N = Math.round(d.windowS * fs);
      if (this.total - d.startTotal < N + Math.round(M.LATENCY_S * fs)) {
        d.onAim({ k: -1, progress: 0, filling: (this.total - d.startTotal) / (N + M.LATENCY_S * fs) });
        return;
      }
      const chans = this.usableChans;
      if (!chans.length) { d.onAim({ k: -1, progress: 0, noSignal: true }); return; }
      const scores = this.scoreWindow(this.total - N, N, d.targets, d.lineFreq);
      if (!scores) return;
      const z = d.calib ? zScores(scores, d.calib) : null;
      if (d.onScores) d.onScores(scores, z, this.total);
      const out = z ? decideZ(z, d.calib.thr) : M.decide(scores);
      d.last = out;
      if (now < d.refractoryUntil) { d.onAim({ k: -1, progress: 0 }); return; }
      // The tile just picked can't be picked again until a window that
      // starts after the pick has filled; until then the old gaze is still
      // in the data and would pick it a second time on its own.
      const locked = d.lock.k === out.winner && now < d.lock.until;
      const clear = z ? out.pass : out.margin >= MARGIN;
      if (clear && !locked && d.isLive(out.winner)) {
        if (d.dwell.k === out.winner) d.dwell.n++;
        else d.dwell = { k: out.winner, n: 1 };
      } else {
        d.dwell = { k: -1, n: 0 };
      }
      if (d.dwell.n >= d.need) {
        const k = d.dwell.k;
        d.dwell = { k: -1, n: 0 };
        d.refractoryUntil = now + REFRACTORY_MS;
        d.lock = { k, until: now + (d.windowS + M.LATENCY_S) * 1000 };
        d.onAim({ k: -1, progress: 0 });
        d.onPick(k);
      } else {
        d.onAim({ k: d.dwell.k, progress: d.dwell.k >= 0 ? d.dwell.n / d.need : 0 });
      }
    }

    /* Raw FBCCA scores of the usable channels for samples [start, start+N),
       or null if the data isn't all there. Used by the decoder above and by
       the accuracy test and calibration, which score fixed trial windows. */
    scoreWindow(start, N, targets, lineFreq) {
      const chans = this.usableChans;
      if (!chans.length) return null;
      const seg = M.extract(this, chans, start, N, 0);
      if (!seg) return null;
      const fLow = Math.min(...targets.map((t) => t.f));
      const bank = M.filterBank(this.fs, fLow, 5, lineFreq || 0);
      return M.scoreCCA(M.subbands(seg, bank), targets, this.fs, bank, true);
    }

    /* Simulator only: the simulated brain answers at the tile under the
       mouse pointer, the way a real one answers at the tile being watched. */
    setSimGaze(k) {
      const src = this.source;
      if (k === this.simGaze && (k < 0 || (src && src.state && src.state.ssvep))) return;
      this.simGaze = k;
      if (!src || src.kind !== 'sim') return;
      if (k < 0 || !this.dec) { src.state.ssvep = null; return; }
      const t = this.dec.targets[k];
      src.state.ssvep = { f: t.f, phase: t.phase, onset: this.total - 1, gain: 0.7 + 0.6 * Math.random() };
    }
  }

  /* Each target's score against its own resting level (mean and spread of
     its scores while the player looked at none of the tiles). This takes
     out what a target scores by itself, which differs between targets: a
     10 Hz tile scores high at rest because of the brain's own alpha. */
  function zScores(scores, calib) {
    return scores.map((s, k) => (s - calib.mu[k]) / calib.sd[k]);
  }

  /* With calibration, a winner must stand clear of its resting level
     (z ≥ its own threshold: thr is one number per target) and of the
     runner-up (by Z_MARGIN). */
  const Z_MARGIN = 1.0;
  function decideZ(z, thr) {
    let w = 0;
    for (let k = 1; k < z.length; k++) if (z[k] > z[w]) w = k;
    let second = -Infinity;
    for (let k = 0; k < z.length; k++) if (k !== w && z[k] > second) second = z[k];
    const t = Array.isArray(thr) ? thr[w] : thr;
    return { scores: z, winner: w, margin: z[w] - second, pass: z[w] >= t && z[w] - second >= Z_MARGIN };
  }

  NP.EegEngine = EegEngine;
  NP.eegZ = { zScores, decideZ, Z_MARGIN };
  NP.EEG_TICK_MS = TICK_MS;
})(window.NP);
