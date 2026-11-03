/* SSVEP frequency recognition and metrics.
     CCA       Lin et al. (2006) IEEE Trans Biomed Eng 53:2610
     FBCCA     Chen et al. (2015) J Neural Eng 12:046008
     FB-eTRCA  Nakanishi et al. (2018) IEEE Trans Biomed Eng 65:104
     SNR       narrow-band SNR against neighbouring bins (Norcia et al., 2015, J Vis 15:4)
     ITR       Wolpaw et al. (1998) IEEE Trans Rehabil Eng 6:326
   All filtering is zero-phase on the raw µV buffer, independent of the
   display filters. */
(function (NP) {
  'use strict';
  const { dsp, util } = NP;
  const LA = NP.linalg;

  const LATENCY_S = 0.14;   // visual pathway latency (Chen et al., 2015, PNAS)
  const UPPER_HZ = 50;      // stays below 60 Hz mains and the 62.5 Hz Nyquist limit
  const FB_A = 1.25, FB_B = 0.25;
  const PRE_PAD_S = 1.0;    // real data before the window lets the filters settle
  const POST_PAD_S = 0.3;

  function fmtHz(f) {
    const r = Math.round(f * 100) / 100;
    return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, '');
  }

  function nHarmonics(f, fs) {
    const top = Math.min(UPPER_HZ, fs / 2 - 2);
    return Math.max(1, Math.min(5, Math.floor(top / f)));
  }

  /* Orthonormal basis of the sine/cosine references at f and the given
     harmonics (default: 1 up to nHarmonics). */
  const refCache = new Map();
  function referenceBasis(f, N, fs, harmonics) {
    const hs = harmonics || Array.from({ length: nHarmonics(f, fs) }, (_, i) => i + 1);
    const key = `${f}|${N}|${fs}|${hs.join(',')}`;
    let Q = refCache.get(key);
    if (!Q) {
      const cols = [];
      for (const h of hs) {
        const s = new Float64Array(N), c = new Float64Array(N);
        for (let n = 0; n < N; n++) {
          const ph = (2 * Math.PI * h * f * n) / fs;
          s[n] = Math.sin(ph);
          c[n] = Math.cos(ph);
        }
        cols.push(LA.center(s), LA.center(c));
      }
      Q = LA.orthoBasis(cols);
      if (refCache.size > 256) refCache.clear();
      refCache.set(key, Q);
    }
    return Q;
  }

  /* Filter bank: sub-band n passes [n·base, 50 Hz] with base just under the
     lowest stimulus frequency; weights n^−1.25 + 0.25 (Chen et al., 2015).
     Mains is notched in every band. One band = plain CCA pre-filtering. */
  const bankCache = new Map();
  function filterBank(fs, fLow, nBands, lineFreq) {
    const line = lineFreq > 0 && lineFreq < fs / 2 ? lineFreq : 0;
    const key = `${fs}|${fLow}|${nBands}|${line}`;
    let bank = bankCache.get(key);
    if (bank) return bank;
    const base = Math.max(4, fLow - 1.5);
    const top = Math.min(UPPER_HZ, fs / 2 - 4);
    bank = [];
    for (let n = 1; n <= nBands; n++) {
      const lo = n * base;
      if (lo > top - 6) break;
      const { chain } = dsp.designChain(fs, { hp: lo, hpOrder: 4, lp: top, lpOrder: 4, notch: line, notchQ: 20 });
      bank.push({ lo, hi: top, chain, weight: Math.pow(n, -FB_A) + FB_B });
    }
    bankCache.set(key, bank);
    return bank;
  }

  /* Raw µV of the given channels for samples [start, start+N), plus up to
     PRE_PAD_S of real data before it and postPad samples after it. Returns
     null until all window samples have arrived. */
  function extract(app, chans, start, N, postPad) {
    const newest = app.total - 1;
    const oldest = app.total - app.raw[0].count;
    if (start < oldest || start + N - 1 > newest) return null;
    const post = Math.max(0, Math.min(postPad | 0, newest - (start + N - 1)));
    const pre = Math.max(0, Math.min(Math.round(PRE_PAD_S * app.fs), start - oldest));
    const len = pre + N + post;
    const endAge = newest - (start + N - 1 + post);
    const data = [];
    for (const c of chans) {
      const x = app.raw[c].copyLast(len, null, endAge);
      if (!util.fillGaps(x)) return null;
      data.push(x);
    }
    return { data, pre, N };
  }

  /* [band][channel] → zero-phase filtered window of N samples. */
  function subbands(seg, bank) {
    const pad = Math.min(seg.data[0].length - 1, 64);
    return bank.map((band) => seg.data.map((x) =>
      dsp.filtfilt(band.chain, LA.center(x), pad).subarray(seg.pre, seg.pre + seg.N)));
  }

  /* For one filter-bank band: the harmonics of each target that fall inside
     it, cut to the count the worst-off target has. Canonical correlation
     grows with the number of reference signals the noise can project onto,
     so a target with more in-band harmonics wins more often on noise alone.
     Measured on pure noise before this, one target won 38% and another 9%
     where 25% is fair; equal counts also raised accuracy at marginal SNR on
     the 12–15 Hz set from 80% to 88%. The margin keeps harmonics off the
     band edges, where the filters halve them (and off a 50 Hz mains line). */
  const HARMONIC_MARGIN_HZ = 1;
  function bandHarmonics(targets, band) {
    const lists = targets.map((t) => {
      const hs = [];
      for (let h = 1; h * t.f <= band.hi - HARMONIC_MARGIN_HZ; h++) if (h * t.f >= band.lo + HARMONIC_MARGIN_HZ) hs.push(h);
      return hs;
    });
    const m = Math.min(...lists.map((l) => l.length));
    return m > 0 ? lists.map((l) => l.slice(0, m)) : null;   // null: the band can't score every target fairly
  }

  /* CCA (one band) or FBCCA (weighted sum of squared correlations). */
  function scoreCCA(bands, targets, fs, bank, useFB) {
    const N = bands[0][0].length;
    const scores = new Array(targets.length).fill(0);
    bands.forEach((chs, n) => {
      const hs = bandHarmonics(targets, bank[n]);
      if (!hs) return;
      const Qx = LA.orthoBasis(chs.map(LA.center));
      targets.forEach((t, k) => {
        const r = LA.maxCanonicalCorr(Qx, referenceBasis(t.f, N, fs, hs[k]));
        scores[k] += useFB ? bank[n].weight * r * r : r;
      });
    });
    return scores;
  }

  /* TRCA spatial filter per class and band: maximise the covariance between
     trials relative to the total variance (S·w = λ·Q·w). Templates are the
     trial means. epochs: [{k, bands: [band][channel] Float64Array(N)}]. */
  function trainTRCA(epochs, targets, bank) {
    const K = targets.length;
    const N = epochs[0].bands[0][0].length;
    const C = epochs[0].bands[0].length;
    const model = { targets: targets.map((t) => ({ f: t.f, phase: t.phase })), bands: [], N, C };
    for (let n = 0; n < bank.length; n++) {
      const W = [], templates = [];
      for (let k = 0; k < K; k++) {
        const trials = epochs.filter((e) => e.k === k).map((e) => e.bands[n].map(LA.center));
        if (trials.length < 2) throw new Error(`need at least 2 calibration trials for ${fmtHz(targets[k].f)} Hz`);
        const U = Array.from({ length: C }, () => new Float64Array(N));
        for (const X of trials) for (let c = 0; c < C; c++) for (let i = 0; i < N; i++) U[c][i] += X[c][i];
        const S = Array.from({ length: C }, () => new Float64Array(C));
        const Q = Array.from({ length: C }, () => new Float64Array(C));
        for (const X of trials) for (let a = 0; a < C; a++) for (let b = 0; b < C; b++) Q[a][b] += LA.dot(X[a], X[b]);
        for (let a = 0; a < C; a++) for (let b = 0; b < C; b++) S[a][b] = LA.dot(U[a], U[b]) - Q[a][b];
        const w = LA.generalizedMaxEig(S, Q);
        if (!w) throw new Error('the calibration data is degenerate. Check that the selected channels are connected');
        W.push(w);
        templates.push(U.map((u) => u.map((v) => v / trials.length)));
      }
      model.bands.push({ W, templates });
    }
    return model;
  }

  function projectFlat(W, chs, N) {
    const K = W.length, C = chs.length;
    const out = new Float64Array(K * N);
    for (let k = 0; k < K; k++) {
      const w = W[k];
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let c = 0; c < C; c++) s += w[c] * chs[c][i];
        out[k * N + i] = s;
      }
    }
    return out;
  }

  /* Ensemble TRCA: project test data and each class template through all
     classes' filters, correlate, and sum across bands with FBCCA weights. */
  function scoreTRCA(bands, model, bank) {
    const N = Math.min(bands[0][0].length, model.N);
    const K = model.targets.length;
    const scores = new Array(K).fill(0);
    if (!model.cache) model.cache = new Map();
    bands.forEach((chs, n) => {
      const bm = model.bands[n];
      if (!bm) return;
      const Z = projectFlat(bm.W, chs, N);
      for (let k = 0; k < K; k++) {
        const key = `${n}|${k}|${N}`;
        let T = model.cache.get(key);
        if (!T) { T = projectFlat(bm.W, bm.templates[k], N); model.cache.set(key, T); }
        scores[k] += bank[n].weight * LA.pearson(Z, T);
      }
    });
    return scores;
  }

  /* Winner, and its lead over the runner-up as a fraction of its score. */
  function decide(scores) {
    let w = 0;
    for (let k = 1; k < scores.length; k++) if (scores[k] > scores[w]) w = k;
    let second = -Infinity;
    for (let k = 0; k < scores.length; k++) if (k !== w && scores[k] > second) second = scores[k];
    const top = scores[w];
    const margin = top > 0 && Number.isFinite(second) ? (top - Math.max(0, second)) / top : 0;
    return { scores, winner: w, margin };
  }

  function powerSpectrum(x, fs) {
    const N = x.length, nfft = dsp.nextPow2(N), w = dsp.hann(N);
    let m = 0;
    for (let i = 0; i < N; i++) m += x[i];
    m /= N;
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < N; i++) re[i] = (x[i] - m) * w[i];
    dsp.fft(re, im);
    const nb = nfft / 2 + 1, P = new Float64Array(nb);
    for (let k = 0; k < nb; k++) P[k] = re[k] * re[k] + im[k] * im[k];
    return { P, binHz: fs / nfft };
  }

  /* Power in bin k over the mean of bins k±3…k±8 (the Hann main lobe, ±2
     bins, is skipped), in dB. */
  function snrBin(P, k) {
    let s = 0, n = 0;
    for (let d = 3; d <= 8; d++) {
      if (k - d > 0) { s += P[k - d]; n++; }
      if (k + d < P.length) { s += P[k + d]; n++; }
    }
    return n && s > 0 && P[k] > 0 ? 10 * Math.log10(P[k] / (s / n)) : NaN;
  }

  function snrAt(P, binHz, f) {
    const k = Math.round(f / binHz);
    return k > 0 && k < P.length ? snrBin(P, k) : NaN;
  }

  function snrSpectrum(P, binHz, fmin, fmax) {
    const k0 = Math.max(1, Math.ceil(fmin / binHz)), k1 = Math.min(P.length - 1, Math.floor(fmax / binHz));
    const f = [], db = [];
    for (let k = k0; k <= k1; k++) { f.push(k * binHz); db.push(snrBin(P, k)); }
    return { f, db };
  }

  /* Wolpaw ITR in bits/min for N classes, accuracy P, T seconds per selection. */
  function itr(N, P, T) {
    if (N < 2 || !(T > 0) || !(P > 1 / N)) return 0;
    const B = P >= 1 ? Math.log2(N) : Math.log2(N) + P * Math.log2(P) + (1 - P) * Math.log2((1 - P) / (N - 1));
    return (B * 60) / T;
  }

  NP.ssvepMethods = {
    LATENCY_S, UPPER_HZ, POST_PAD_S, fmtHz, nHarmonics, referenceBasis, bandHarmonics, filterBank, extract, subbands,
    scoreCCA, trainTRCA, scoreTRCA, decide, powerSpectrum, snrAt, snrSpectrum, itr,
  };
})(window.NP);
