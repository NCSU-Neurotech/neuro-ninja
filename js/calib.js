/* Calibration and the accuracy test. Both run on the game engine (same
   tiles, same flicker, same fullscreen and pause) but aren't games, so they
   are registered as hidden modes and started from the home screen's
   "Test your signal" card.

   Calibrate
     1. Rest, 20 s: look at a dot in the middle while all four tiles
        flicker. Every window's scores are kept. This is what each target
        scores when nobody is looking at it, and it differs between targets:
        a 10 Hz tile scores high at rest because of the brain's own alpha.
     2. Eight cued looks (each tile twice): a red outline says where to look.
     The games then measure each target against its own resting level
     (mean and spread, as a z-score) and pick only when the winner stands
     clear of rest. This is per-user null normalisation, the step listed as
     next for the lean towards some targets in EXG Visualizer+.

   Accuracy test
     12 or 20 cued looks, each tile equally often in random order. The tile
     with the highest score in a 2 s window is the answer (forced choice,
     like EXG Visualizer+'s cued test). Reports accuracy against the 25%
     chance level, the odds of doing that well by guessing, and, when a
     calibration exists, accuracy with and without it on the same trials. */
(function (NP) {
  'use strict';
  const Z = NP.eegZ;

  const CALIB_KEY = 'neuro-ninja-calib', TEST_KEY = 'neuro-ninja-last-test';
  const REST_S = 20;
  const CUE_S = 1.0;            // time to move the eyes before the window starts
  const FEEDBACK_S = 0.6;
  const CALIB_BLOCKS = 2;
  const TILE_NAMES = ['top left', 'bottom right', 'bottom left', 'top right'];

  const fmtHz = (f) => (Number.isInteger(f) ? String(f) : f.toFixed(2).replace(/0$/, ''));
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const argmax = (a) => { let w = 0; for (let k = 1; k < a.length; k++) if (a[k] > a[w]) w = k; return w; };
  const sameChans = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

  /* P(at least c right out of n) by guessing among k targets. */
  function guessOdds(c, n, k) {
    const p = 1 / k;
    let tail = 0, comb = 1;
    for (let i = 0; i <= n; i++) {
      if (i > 0) comb = (comb * (n - i + 1)) / i;
      if (i >= c) tail += comb * Math.pow(p, i) * Math.pow(1 - p, n - i);
    }
    return tail;
  }
  function fmtOdds(p) {
    if (!(p > 0)) return '—';
    if (p > 0.2) return `${Math.round(100 * p)}% (could easily be luck)`;
    const n = 1 / p;
    const r = n >= 1e6 ? `${Math.round(n / 1e6)} million` : n >= 1000 ? `${Math.round(n / 1000) * 1000}`.replace(/\B(?=(\d{3})+$)/g, ',') : String(Math.round(n));
    return `1 in ${r}`;
  }

  /* ---------------- stored calibration ---------------- */
  function loadAll(key) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
  }
  function validEntry(e) {
    const arr4 = (a) => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite);
    return e && arr4(e.mu) && arr4(e.sd) && e.sd.every((s) => s > 0) && arr4(e.thr) &&
      Array.isArray(e.chans) && e.chans.every((c) => Number.isInteger(c) && c >= 0 && c < 8);
  }
  const keyFor = (rates, windowS) => `${rates}|${windowS}`;

  /* Tiles the brain answered weakly in calibration (z below 3), and why
     that's likely. Alpha, the brain's own 8–13 Hz rhythm, swamps a tile in
     that range: its score is already high and jumpy at rest. */
  function weakTiles(e, targets) {
    const weak = [0, 1, 2, 3].filter((k) => !(e.zAttended[k] >= 3));
    if (!weak.length) return '';
    const list = weak.map((k) => `${fmtHz(targets[k].f)} Hz (z ${Number.isFinite(e.zAttended[k]) ? e.zAttended[k].toFixed(1) : '—'})`).join(', ');
    const alpha = weak.some((k) => targets[k].f >= 8 && targets[k].f <= 13);
    return alpha
      ? `${list}. Your alpha rhythm is probably in the way; the 12–15 Hz set avoids it.`
      : `${list}. Check the electrodes at the back of the head and calibrate again.`;
  }

  NP.calib = {
    /* The calibration for these settings, or why there isn't a usable one. */
    find({ rates, windowS, lineFreq, chans }) {
      const e = loadAll(CALIB_KEY)[keyFor(rates, windowS)];
      if (!validEntry(e)) return { entry: null, why: 'none' };
      if (e.lineFreq !== lineFreq) return { entry: null, why: 'mains', saved: e };
      if (chans && !sameChans(e.chans, chans)) return { entry: null, why: 'chans', saved: e };
      return { entry: e, why: '' };
    },
    save(e) {
      const all = loadAll(CALIB_KEY);
      all[keyFor(e.rates, e.windowS)] = e;
      try { localStorage.setItem(CALIB_KEY, JSON.stringify(all)); } catch (err) { /* storage blocked */ }
    },
    clear(rates, windowS) {
      const all = loadAll(CALIB_KEY);
      delete all[keyFor(rates, windowS)];
      try { localStorage.setItem(CALIB_KEY, JSON.stringify(all)); } catch (err) { /* storage blocked */ }
    },
    lastTest() {
      const t = loadAll(TEST_KEY);
      return Number.isFinite(t.acc) && Number.isFinite(t.n) ? t : null;
    },
    saveTest(t) { try { localStorage.setItem(TEST_KEY, JSON.stringify(t)); } catch (err) { /* storage blocked */ } },
    weakTiles, guessOdds, fmtOdds,
  };

  /* ---------------- shared cued-trial machinery ---------------- */
  /* Each trial: the red outline shows for CUE_S while the eyes move, then
     the next windowS of EEG is scored, then FEEDBACK_S of green or orange.
     The flicker runs throughout (steady state, as in the games). */
  class CuedBase {
    constructor(game) {
      this.g = game;
      this.noScore = true;
      this.noCombo = true;
      this.cue = -1;
      this.phase = 'intro';
      this.phaseT = 0;
      this.trials = [];
      this.i = -1;
      this.hud = { label: '' };
    }
    get eeg() { return this.g.eeg; }
    get N() { return Math.round(this.g.opts.windowS * this.eeg.fs); }
    isLive() { return false; }
    go(p) { this.phase = p; this.phaseT = 0; }

    /* The flicker (re)started, after the countdown or a pause: a trial
       that was under way restarts with a fresh window. */
    onFlickerStart() {
      if (this.phase === 'cue' || this.phase === 'window' || this.phase === 'feedback') { this.i--; this.nextTrial(); }
    }

    nextTrial() {
      this.i++;
      if (this.i >= this.trials.length) { this.cue = -1; this.trialsDone(); return; }
      this.cue = this.trials[this.i];
      this.hud.label = `${this.trialWord} ${this.i + 1} of ${this.trials.length}`;
      this.go('cue');
    }

    updateTrials(gdt) {
      this.phaseT += gdt;
      if (this.phase === 'cue' && this.phaseT >= CUE_S) {
        this.winStart = this.eeg.total;
        this.go('window');
      } else if (this.phase === 'window' && this.eeg.total >= this.winStart + this.N) {
        const s = this.eeg.scoreWindow(this.winStart, this.N, this.g.targets, this.g.opts.lineFreq);
        const k = this.cue;
        this.go('feedback');
        if (!s) { this.g.text(this.g.dims.w / 2, this.g.dims.h * 0.45, 'No clean data: trial skipped', 'rgba(255,200,150,1)', 1, 1.5); this.skipped = (this.skipped || 0) + 1; return; }
        this.scored(k, s);
      } else if (this.phase === 'feedback' && this.phaseT >= FEEDBACK_S) {
        this.nextTrial();
      }
    }

    feedback(pick, k) {
      this.g.ring(pick, pick === k ? '120,230,120' : '255,170,60');
      if (pick === k) this.g.sfx.note(660); else this.g.sfx.whiff();
    }

    get hint() {
      if (this.phase === 'cue' || this.phase === 'window') return 'Look at the tile with the red outline';
      return this.extraHint || '';
    }

    drawFrame(ctx, k, r) {
      if (this.cue !== k || !(this.phase === 'cue' || this.phase === 'window')) return;
      ctx.strokeStyle = '#ff4d4d';
      ctx.lineWidth = 7;
      ctx.strokeRect(r.x - 13, r.y - 13, r.s + 26, r.s + 26);
    }
  }

  /* ---------------- Accuracy test ---------------- */
  class AccuracyMode extends CuedBase {
    constructor(game) {
      super(game);
      this.title = 'Accuracy test';
      this.trialWord = 'Look';
      this.countdownText = 'Look at each tile when it gets a red outline';
      this.endText = 'Done!';
      const blocks = game.opts.blocks || 3;
      for (let b = 0; b < blocks; b++) this.trials.push(...shuffle([0, 1, 2, 3]));
      this.calib = game.opts.calib || null;
      this.res = { n: 0, raw: 0, cal: 0, perTile: [[0, 0], [0, 0], [0, 0], [0, 0]], confusion: [0, 1, 2, 3].map(() => [0, 0, 0, 0]) };
      this.hud.label = `${this.trials.length} looks`;
    }

    begin() { this.go('intro'); }

    update(gdt) {
      if (this.phase === 'intro') { this.phaseT += gdt; if (this.phaseT >= 0.6) this.nextTrial(); return; }
      this.updateTrials(gdt);
    }

    scored(k, s) {
      const R = this.res;
      const rawPick = argmax(s);
      const calPick = this.calib ? argmax(Z.zScores(s, this.calib)) : rawPick;
      const pick = this.calib ? calPick : rawPick;
      R.n++;
      if (rawPick === k) R.raw++;
      if (calPick === k) R.cal++;
      R.perTile[k][1]++;
      if (pick === k) R.perTile[k][0]++;
      R.confusion[k][pick]++;
      this.feedback(pick, k);
    }

    trialsDone() {
      const R = this.res, g = this.g;
      const correct = this.calib ? R.cal : R.raw;
      NP.calib.saveTest({
        acc: R.n ? correct / R.n : NaN, n: R.n, correct, rates: g.opts.rates, windowS: g.opts.windowS,
        calibrated: !!this.calib, rawAcc: R.n ? R.raw / R.n : NaN, at: new Date().toISOString(),
      });
      g.endGame('done');
    }

    result() {
      const R = this.res, correct = this.calib ? R.cal : R.raw;
      return {
        title: 'Accuracy test',
        big: R.n ? `${Math.round((100 * correct) / R.n)}%` : '—',
        sub: R.n ? `${correct} of ${R.n} right · guessing gets 25%` : 'No trials were scored',
      };
    }

    summaryRows() {
      const R = this.res, g = this.g, correct = this.calib ? R.cal : R.raw;
      const rows = [
        ['Right', `${correct} of ${R.n}`],
        ['Odds of this by guessing', R.n ? fmtOdds(guessOdds(correct, R.n, 4)) : '—'],
      ];
      if (this.calib) rows.push(['Without calibration', R.n ? `${Math.round((100 * R.raw) / R.n)}%` : '—']);
      else rows.push(['Calibration', 'none: calibrate for fair odds between tiles']);
      const T = g.opts.windowS + 0.5;   // window plus time to move the eyes (Chen et al., 2015)
      const bits = R.n ? NP.ssvepMethods.itr(4, correct / R.n, T) : 0;
      rows.push(['Information rate', bits > 0 ? `${bits.toFixed(0)} bits/min` : '—']);
      g.targets.forEach((t, k) => {
        const [c, n] = R.perTile[k];
        rows.push([`${fmtHz(t.f)} Hz · ${TILE_NAMES[k]}`, `${c} of ${n}`]);
      });
      if (this.skipped) rows.push(['Skipped (no clean data)', this.skipped]);
      return rows;
    }
  }

  /* ---------------- Calibration ---------------- */
  class CalibMode extends CuedBase {
    constructor(game) {
      super(game);
      this.title = 'Calibration';
      this.trialWord = 'Look';
      this.countdownText = 'First, look at the dot in the middle';
      this.endText = 'Done!';
      for (let b = 0; b < CALIB_BLOCKS; b++) this.trials.push(...shuffle([0, 1, 2, 3]));
      this.rest = [];
      this.restT = 0;
      this.att = [[], [], [], []];
      this.ok = 0;
      this.n = 0;
      this.outcome = null;
      this.hud.label = 'Step 1 of 2: rest';
    }

    begin() { this.go('rest'); }

    /* Rest windows come from the live decoder: only clean ones, every
       250 ms, starting once a full window has filled after the flicker. */
    onScores(scores) { if (this.phase === 'rest') this.rest.push(scores.slice()); }

    update(gdt) {
      if (this.phase === 'rest') {
        this.restT += gdt;
        this.hud.label = `Step 1 of 2: rest · ${Math.max(0, Math.ceil(REST_S - this.restT))} s`;
        if (this.restT >= REST_S) this.finishRest();
        return;
      }
      if (this.phase === 'between') {
        this.phaseT += gdt;
        if (this.phaseT >= 1.6) this.nextTrial();
        return;
      }
      this.updateTrials(gdt);
    }

    finishRest() {
      const n = this.rest.length;
      if (n < 20) { this.fail('Not enough clean data during the rest. Check the electrodes and try again.'); return; }
      this.mu = [0, 1, 2, 3].map((k) => this.rest.reduce((a, s) => a + s[k], 0) / n);
      this.sd = [0, 1, 2, 3].map((k) => {
        const v = this.rest.reduce((a, s) => a + (s[k] - this.mu[k]) ** 2, 0) / (n - 1);
        return Math.max(Math.sqrt(v), 1e-6, 0.02 * this.mu[k]);
      });
      this.trialWord = 'Step 2 of 2: look';
      this.extraHint = 'Now look at each tile when it gets a red outline';
      this.go('between');
    }

    scored(k, s) {
      const z = Z.zScores(s, { mu: this.mu, sd: this.sd });
      const pick = argmax(z);
      this.att[k].push(z[k]);
      this.n++;
      if (pick === k) this.ok++;
      this.feedback(pick, k);
    }

    trialsDone() {
      const g = this.g, all = [].concat(...this.att);
      const zMed = median(all);
      if (this.ok / Math.max(1, this.n) < 0.5 || !(zMed > 1.5)) {
        this.fail(`Only ${this.ok} of ${this.n} looks were picked right, so this calibration wasn't saved. Check the electrodes on the back of the head and try again.`);
        return;
      }
      // One threshold per tile, from that tile's own response: a tile your
      // brain answers weakly (often the one sitting on your alpha rhythm)
      // would otherwise be held to the strong tiles' standard and almost
      // never get picked. The floor of 2 keeps rest from firing it.
      const zTile = this.att.map(median);
      const thr = zTile.map((v) => Math.min(5, Math.max(2, 0.4 * (Number.isFinite(v) ? v : zMed))));
      const entry = {
        rates: g.opts.rates, windowS: g.opts.windowS, lineFreq: g.opts.lineFreq, chans: this.eeg.usableChans.slice(),
        mu: this.mu, sd: this.sd, thr, zAttended: zTile, acc: this.ok / this.n, n: this.n,
        restWindows: this.rest.length, at: new Date().toISOString(),
      };
      NP.calib.save(entry);
      this.outcome = { ok: true, entry };
      g.endGame('done');
    }

    fail(why) {
      this.outcome = { ok: false, why };
      this.cue = -1;
      this.endText = 'Calibration not saved';
      this.g.endGame('fail');
    }

    get hint() {
      if (this.phase === 'rest') return "Look at the dot. Don't look at the tiles.";
      return super.hint;
    }

    /* The fixation dot, with a ring that runs down over the rest. */
    drawWorld(ctx) {
      if (this.phase !== 'rest') return;
      const D = this.g.dims, cx = D.w / 2, cy = D.h / 2, R = D.m * 0.035;
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#ffd84a';
      ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + (1 - this.restT / REST_S) * Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#fff6e6';
      ctx.beginPath(); ctx.arc(cx, cy, D.m * 0.009, 0, Math.PI * 2); ctx.fill();
    }

    result() {
      if (!this.outcome || !this.outcome.ok) return { title: 'Calibration not saved', big: '✗', sub: this.outcome ? this.outcome.why : '' };
      return { title: 'Calibrated', big: `${this.ok}/${this.n}`, sub: 'Saved. The games now measure each tile against your own resting level.' };
    }

    summaryRows() {
      if (!this.outcome || !this.outcome.ok) return [['Resting windows', this.rest.length], ['Looks picked right', `${this.ok} of ${this.n}`]];
      const e = this.outcome.entry, t = this.g.targets;
      const best = argmax(e.zAttended), worst = argmax(e.zAttended.map((v) => -v));
      const rows = [
        ['Resting data', `${REST_S} s (${e.restWindows} windows)`],
        ['Looks picked right', `${this.ok} of ${this.n}`],
        ['Strongest response', `${fmtHz(t[best].f)} Hz (z ${e.zAttended[best].toFixed(1)})`],
        ['Weakest response', `${fmtHz(t[worst].f)} Hz (z ${e.zAttended[worst].toFixed(1)})`],
        ['Pick thresholds', `z ≥ ${Math.min(...e.thr).toFixed(1)} to ${Math.max(...e.thr).toFixed(1)}`],
        ['Channels', e.chans.map((c) => c + 1).join(', ')],
      ];
      const weak = weakTiles(e, t);
      if (weak) rows.push(['Weak tile', weak]);
      return rows;
    }
  }

  NP.modes.acc = { cls: AccuracyMode, hidden: true, name: 'Accuracy test' };
  NP.modes.calib = { cls: CalibMode, hidden: true, name: 'Calibrate' };
})(window.NP);
