/* Signal processing: IIR biquads, FFT, Welch PSD, spectral parameters. */
(function (NP) {
  'use strict';

  /* Direct Form II transposed biquad (double precision). */
  class Biquad {
    constructor(b0, b1, b2, a1, a2) {
      this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
      this.s1 = 0; this.s2 = 0;
    }
    process(x) {
      const y = this.b0 * x + this.s1;
      this.s1 = this.b1 * x - this.a1 * y + this.s2;
      this.s2 = this.b2 * x - this.a2 * y;
      return y;
    }
    dcGain() {
      const den = 1 + this.a1 + this.a2;
      return Math.abs(den) < 1e-15 ? 0 : (this.b0 + this.b1 + this.b2) / den;
    }
    /* Set the state to the steady-state response for a constant input x0
       (the same idea as scipy's lfilter_zi) so a DC offset doesn't ring. */
    reset(x0) {
      x0 = x0 || 0;
      const y = this.dcGain() * x0;
      this.s2 = this.b2 * x0 - this.a2 * y;
      this.s1 = this.b1 * x0 - this.a1 * y + this.s2;
      return y;
    }
    clone() { return new Biquad(this.b0, this.b1, this.b2, this.a1, this.a2); }
  }

  /* RBJ Audio EQ Cookbook designs (bilinear transform, prewarped at f0). */
  function rbj(type, fs, f0, Q) {
    const w0 = 2 * Math.PI * f0 / fs, cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Q);
    let b0, b1, b2;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else if (type === 'notch') { b0 = 1; b1 = -2 * cw; b2 = 1; }
    else throw new Error('unknown biquad type ' + type);
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }

  /* Section Qs of an even-order Butterworth filter. Cascading RBJ sections
     with these Qs (all at the same f0) is an exact bilinear Butterworth. */
  function butterworthQs(order) {
    const qs = [];
    for (let k = 1; k <= order / 2; k++) qs.push(1 / (2 * Math.cos((2 * k - 1) * Math.PI / (2 * order))));
    return qs;
  }

  class FilterChain {
    constructor(sections) { this.sections = sections || []; }
    process(x) {
      const s = this.sections;
      for (let i = 0; i < s.length; i++) x = s[i].process(x);
      return x;
    }
    reset(x0) { let x = x0; for (const s of this.sections) x = s.reset(x); }
    clone() { return new FilterChain(this.sections.map((s) => s.clone())); }
    get empty() { return this.sections.length === 0; }
  }

  /* spec: {hp, hpOrder, lp, lpOrder, notch, notchQ}. Frequencies in Hz, 0 = off. */
  function designChain(fs, spec) {
    const nyq = fs / 2;
    const sections = [], parts = [];
    const hpOrder = spec.hpOrder || 2, lpOrder = spec.lpOrder || 4, notchQ = spec.notchQ || 30;
    const ord = (n) => (n === 2 ? '2nd' : n === 4 ? '4th' : n + 'th');
    if (spec.hp > 0 && spec.hp < nyq * 0.9) {
      for (const q of butterworthQs(hpOrder)) sections.push(rbj('highpass', fs, spec.hp, q));
      parts.push(`High-pass ${spec.hp} Hz (${ord(hpOrder)}-order Butterworth)`);
    }
    if (spec.lp > 0) {
      if (spec.lp < nyq * 0.95) {
        for (const q of butterworthQs(lpOrder)) sections.push(rbj('lowpass', fs, spec.lp, q));
        parts.push(`low-pass ${spec.lp} Hz (${ord(lpOrder)}-order Butterworth)`);
      } else {
        parts.push(`low-pass ${spec.lp} Hz skipped (at or above Nyquist ${nyq} Hz)`);
      }
    }
    if (spec.notch > 0) {
      if (spec.notch < nyq * 0.98) {
        sections.push(rbj('notch', fs, spec.notch, notchQ));
        parts.push(`notch ${spec.notch} Hz (Q ${notchQ})`);
      } else {
        parts.push(`notch ${spec.notch} Hz skipped (above Nyquist)`);
      }
    }
    return { chain: new FilterChain(sections), parts };
  }

  /* Zero-phase forward–backward filtering with odd-reflection padding.
     Magnitude response is squared; phase is zero, so latencies are preserved. */
  function filtfilt(template, x, padLen) {
    const n = x.length;
    if (n < 3 || template.empty) return Float64Array.from(x);
    padLen = Math.max(0, Math.min(padLen | 0, n - 1));
    const ext = new Float64Array(n + 2 * padLen);
    for (let i = 0; i < padLen; i++) ext[i] = 2 * x[0] - x[padLen - i];
    ext.set(x, padLen);
    for (let i = 0; i < padLen; i++) ext[padLen + n + i] = 2 * x[n - 1] - x[n - 2 - i];
    let f = template.clone();
    f.reset(ext[0]);
    for (let i = 0; i < ext.length; i++) ext[i] = f.process(ext[i]);
    f = template.clone();
    f.reset(ext[ext.length - 1]);
    for (let i = ext.length - 1; i >= 0; i--) ext[i] = f.process(ext[i]);
    return ext.slice(padLen, padLen + n);
  }

  /* ---------------- FFT (iterative, radix-2) ---------------- */
  const plans = new Map();
  function plan(n) {
    let p = plans.get(n);
    if (p) return p;
    const rev = new Uint32Array(n);
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos(2 * Math.PI * k / n); sin[k] = Math.sin(2 * Math.PI * k / n); }
    p = { rev, cos, sin };
    plans.set(n, p);
    return p;
  }

  function fft(re, im) {
    const n = re.length, p = plan(n);
    for (let i = 0; i < n; i++) {
      const j = p.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const l = i + j + half;
          const tre = re[l] * p.cos[k] + im[l] * p.sin[k];
          const tim = im[l] * p.cos[k] - re[l] * p.sin[k];
          re[l] = re[i + j] - tre; im[l] = im[i + j] - tim;
          re[i + j] += tre; im[i + j] += tim;
        }
      }
    }
  }

  const nextPow2 = (n) => 1 << Math.ceil(Math.log2(Math.max(2, n)));

  const windows = new Map();
  function hann(n) {
    let w = windows.get(n);
    if (!w) {
      w = new Float64Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); // periodic Hann
      windows.set(n, w);
    }
    return w;
  }

  /* Welch's averaged, modified periodogram. One-sided PSD in (units)²/Hz.
     Each segment has its least-squares line removed (so electrode drift
     doesn't leak into the delta band) and is Hann-windowed. */
  function welch(x, fs, nperseg, overlap) {
    const n = x.length;
    nperseg = Math.max(8, Math.min(nperseg | 0, n));
    overlap = overlap == null ? 0.5 : overlap;
    const nfft = nextPow2(nperseg);
    const step = Math.max(1, Math.round(nperseg * (1 - overlap)));
    const nseg = Math.max(1, Math.floor((n - nperseg) / step) + 1);
    const w = hann(nperseg);
    let s2 = 0;
    for (let i = 0; i < nperseg; i++) s2 += w[i] * w[i];
    const nb = nfft / 2 + 1;
    const psd = new Float64Array(nb);
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    const tc = (nperseg - 1) / 2, stt = (nperseg * (nperseg * nperseg - 1)) / 12;
    for (let s = 0; s < nseg; s++) {
      const off = s * step;
      let sy = 0, sty = 0;
      for (let i = 0; i < nperseg; i++) { sy += x[off + i]; sty += (i - tc) * x[off + i]; }
      const a = sy / nperseg, b = sty / stt;
      re.fill(0); im.fill(0);
      for (let i = 0; i < nperseg; i++) re[i] = (x[off + i] - (a + b * (i - tc))) * w[i];
      fft(re, im);
      for (let k = 0; k < nb; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
    }
    const scale = 1 / (fs * s2 * nseg);
    for (let k = 0; k < nb; k++) psd[k] *= (k === 0 || k === nb - 1) ? scale : 2 * scale;
    const freqs = new Float64Array(nb);
    for (let k = 0; k < nb; k++) freqs[k] = k * fs / nfft;
    return { freqs, psd, nseg, resolution: fs / nperseg, binHz: fs / nfft };
  }

  /* Integrated power over [lo, hi) Hz (rectangle rule on the bin grid). */
  function bandPower(freqs, psd, lo, hi) {
    const bin = freqs.length > 1 ? freqs[1] - freqs[0] : 1;
    let p = 0;
    for (let k = 0; k < freqs.length; k++) {
      if (freqs[k] >= lo && freqs[k] < hi) p += psd[k];
    }
    return p * bin;
  }

  function meanDensity(freqs, psd, lo, hi) {
    let s = 0, c = 0;
    for (let k = 0; k < freqs.length; k++) if (freqs[k] >= lo && freqs[k] <= hi) { s += psd[k]; c++; }
    return c ? s / c : NaN;
  }

  function linfit(xs, ys) {
    const n = xs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    const den = n * sxx - sx * sx;
    if (n < 2 || Math.abs(den) < 1e-12) return null;
    const slope = (n * sxy - sx * sy) / den;
    const icpt = (sy - slope * sx) / n;
    let ssr = 0, sst = 0;
    const my = sy / n;
    for (let i = 0; i < n; i++) { const e = ys[i] - (icpt + slope * xs[i]); ssr += e * e; sst += (ys[i] - my) ** 2; }
    return { slope, icpt, r2: sst > 0 ? 1 - ssr / sst : 0 };
  }

  /* Aperiodic fit in log-log space: log10 P = offset − exponent·log10 f.
     Excludes the alpha range, then refits without points sitting well above
     the first fit (other oscillatory peaks). After Donoghue et al. (2020). */
  function aperiodicFit(freqs, psd, opts) {
    opts = opts || {};
    const fmin = opts.fmin || 2, fmax = opts.fmax || 40;
    const exclude = opts.exclude || [[7, 14]];
    let xs = [], ys = [];
    for (let k = 0; k < freqs.length; k++) {
      const f = freqs[k];
      if (f < fmin || f > fmax || !(psd[k] > 0)) continue;
      if (exclude.some(([a, b]) => f >= a && f <= b)) continue;
      xs.push(Math.log10(f)); ys.push(Math.log10(psd[k]));
    }
    let fit = linfit(xs, ys);
    if (!fit) return null;
    const keepX = [], keepY = [];
    for (let i = 0; i < xs.length; i++) {
      if (ys[i] - (fit.icpt + fit.slope * xs[i]) <= 0.15) { keepX.push(xs[i]); keepY.push(ys[i]); }
    }
    if (keepX.length >= 8) fit = linfit(keepX, keepY) || fit;
    return { offset: fit.icpt, exponent: -fit.slope, r2: fit.r2, fmin, fmax };
  }

  /* Largest peak above the aperiodic fit in [lo, hi] Hz, refined by parabolic
     interpolation. Requires ≥ 0.1 log10 units (~26%) above the fit. */
  function peakAboveFit(freqs, psd, fit, lo, hi) {
    if (!fit) return null;
    lo = lo || 7; hi = hi || 14;
    let best = -1, bestR = -Infinity;
    const resid = (k) => Math.log10(psd[k]) - (fit.offset - fit.exponent * Math.log10(freqs[k]));
    for (let k = 1; k < freqs.length - 1; k++) {
      if (freqs[k] < lo || freqs[k] > hi || !(psd[k] > 0)) continue;
      const r = resid(k);
      if (r > bestR) { bestR = r; best = k; }
    }
    if (best < 1 || bestR < 0.1) return null;
    const rl = resid(best - 1), rr = resid(best + 1);
    if (!(rl <= bestR && rr <= bestR)) return null; // edge of range, not a local maximum
    const den = rl - 2 * bestR + rr;
    const delta = Math.abs(den) > 1e-12 ? 0.5 * (rl - rr) / den : 0;
    const bin = freqs[1] - freqs[0];
    return { freq: freqs[best] + delta * bin, height: bestR };
  }

  /* Mains interference: RMS amplitude of the line peak above its local floor,
     and its prominence in dB. The floor is taken 3–8 Hz below the line. */
  function lineNoise(freqs, psd, f0) {
    const nyq = freqs[freqs.length - 1];
    if (!(f0 > 0) || f0 + 1 > nyq) return { rms: NaN, prominenceDb: NaN };
    const bin = freqs[1] - freqs[0];
    let peak = 0, count = 0;
    for (let k = 0; k < freqs.length; k++) if (Math.abs(freqs[k] - f0) <= 1) { peak += psd[k]; count++; }
    const floor = meanDensity(freqs, psd, f0 - 8, f0 - 3);
    const excess = Math.max(0, peak - floor * count) * bin;
    const prominenceDb = floor > 0 && count ? 10 * Math.log10((peak / count) / floor) : NaN;
    return { rms: Math.sqrt(excess), prominenceDb };
  }

  function rms(x) {
    let s = 0, c = 0, m = 0;
    for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i])) { m += x[i]; c++; }
    if (!c) return NaN;
    m /= c;
    for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i])) s += (x[i] - m) ** 2;
    return Math.sqrt(s / c);
  }

  NP.dsp = {
    Biquad, FilterChain, rbj, butterworthQs, designChain, filtfilt,
    fft, nextPow2, hann, welch, bandPower, meanDensity,
    aperiodicFit, peakAboveFit, lineNoise, rms,
  };
})(window.NP);
