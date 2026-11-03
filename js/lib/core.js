/* Core: namespace, ring buffer, formatting, theme tokens, tooltip, zip. */
window.NP = window.NP || {};

(function (NP) {
  'use strict';

  /* Fixed-capacity circular buffer of Float32 samples. Ages are counted
     back from the newest sample (age 0). Several buffers pushed in lock-step
     share the same `total`, so the same age addresses the same instant. */
  class RingBuffer {
    constructor(capacity, ArrayType) {
      this.capacity = capacity;
      this.data = new (ArrayType || Float32Array)(capacity);
      this.head = 0;   // next write index
      this.count = 0;  // valid samples
      this.total = 0;  // samples ever pushed
    }
    push(v) {
      this.data[this.head] = v;
      this.head = this.head + 1 === this.capacity ? 0 : this.head + 1;
      if (this.count < this.capacity) this.count++;
      this.total++;
    }
    /* Value at `age` samples before the newest (0 = newest). */
    at(age) {
      let i = this.head - 1 - age;
      if (i < 0) i += this.capacity;
      return this.data[i];
    }
    /* Overwrite value at age (used when re-filtering history). */
    setAt(age, v) {
      let i = this.head - 1 - age;
      if (i < 0) i += this.capacity;
      this.data[i] = v;
    }
    /* Copy the n samples ending `endAge` samples ago into out (oldest first).
       Missing history is left as NaN. Returns out. */
    copyLast(n, out, endAge) {
      endAge = endAge || 0;
      out = out || new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const age = endAge + (n - 1 - k);
        out[k] = age < this.count ? this.at(age) : NaN;
      }
      return out;
    }
    clear() { this.head = 0; this.count = 0; this.total = 0; }
  }

  /* ---------------- formatting & math helpers ---------------- */
  const util = {
    clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),

    /* Round up to a 1-2-5 sequence value. */
    niceCeil125(v) {
      if (!(v > 0)) return 1;
      const p = Math.pow(10, Math.floor(Math.log10(v)));
      const m = v / p;
      const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
      return step * p;
    },

    /* Evenly spaced "nice" ticks covering [lo, hi]. */
    niceTicks(lo, hi, maxTicks) {
      if (!(hi > lo)) return { ticks: [lo], step: 1 };
      const raw = (hi - lo) / Math.max(1, maxTicks || 5);
      const p = Math.pow(10, Math.floor(Math.log10(raw)));
      const m = raw / p;
      const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
      const start = Math.ceil(lo / step - 1e-9) * step;
      const ticks = [];
      for (let t = start; t <= hi + step * 1e-9; t += step) ticks.push(+t.toFixed(10));
      return { ticks, step };
    },

    fmt(v, digits) {
      if (v == null || !Number.isFinite(v)) return '—';
      const a = Math.abs(v);
      if (digits == null) digits = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
      return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    },

    /* Compact scientific-ish formatting for spectral values. */
    fmtPower(v) {
      if (!Number.isFinite(v)) return '—';
      const a = Math.abs(v);
      if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k';
      if (a >= 10) return v.toFixed(0);
      if (a >= 1) return v.toFixed(1);
      if (a >= 0.1) return v.toFixed(2);
      if (a === 0) return '0';
      return v.toExponential(1);
    },

    fmtDuration(sec) {
      sec = Math.max(0, Math.floor(sec));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
      return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    },

    /* Two-sided 95% critical value of Student's t. Exact to df 30, then
       interpolated in 1/df towards 1.96, which is how t behaves. */
    tcrit95(df) {
      if (!(df >= 1)) return NaN;
      const T = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
        2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
        2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
      if (df <= 30) {
        const lo = Math.floor(df), f = df - lo;
        return f ? T[lo - 1] + f * (T[lo] - T[lo - 1]) : T[lo - 1];
      }
      const pts = [[30, 2.042], [40, 2.021], [60, 2.000], [120, 1.980], [Infinity, 1.960]];
      for (let i = 0; i < pts.length - 1; i++) {
        const [d0, t0] = pts[i], [d1, t1] = pts[i + 1];
        if (df <= d1) {
          const f = (1 / d0 - 1 / df) / (1 / d0 - 1 / d1);
          return t0 + f * (t1 - t0);
        }
      }
      return 1.96;
    },

    median(arr) {
      const a = Array.from(arr).filter(Number.isFinite).sort((x, y) => x - y);
      if (!a.length) return NaN;
      const mid = a.length >> 1;
      return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
    },

    /* Median absolute deviation (unscaled). */
    mad(arr, med) {
      if (med == null) med = util.median(arr);
      const dev = [];
      for (let i = 0; i < arr.length; i++) if (Number.isFinite(arr[i])) dev.push(Math.abs(arr[i] - med));
      return util.median(dev);
    },

    /* Replace NaN gaps by carrying the previous finite value (leading gaps
       take the first finite value). Used before spectral analysis only. */
    fillGaps(arr) {
      let last = NaN;
      for (let i = 0; i < arr.length; i++) { if (Number.isFinite(arr[i])) { last = arr[i]; break; } }
      if (!Number.isFinite(last)) return false;
      for (let i = 0; i < arr.length; i++) {
        if (Number.isFinite(arr[i])) last = arr[i]; else arr[i] = last;
      }
      return true;
    },

    el(tag, attrs, children) {
      const node = document.createElement(tag);
      if (attrs) {
        for (const k in attrs) {
          const v = attrs[k];
          if (v == null || v === false) continue;
          if (k === 'class') node.className = v;
          else if (k === 'text') node.textContent = v;
          else if (k === 'style') node.style.cssText = v;
          else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
          else node.setAttribute(k, v === true ? '' : v);
        }
      }
      if (children) for (const c of children) if (c) node.append(c);
      return node;
    },

    downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },

    timestampForFile(d) {
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    },
  };

  /* ---------------- theme tokens for canvas drawing ---------------- */
  const theme = {
    c: {},
    font: 'system-ui, sans-serif',
    read() {
      const cs = getComputedStyle(document.documentElement);
      const v = (name) => cs.getPropertyValue(name).trim();
      const c = {
        bg: v('--bg'), surface: v('--surface-1'), surface2: v('--surface-2'), surface3: v('--surface-3'),
        text1: v('--text-1'), text2: v('--text-2'), text3: v('--text-3'),
        grid: v('--grid'), axis: v('--axis'), accent: v('--accent'),
        good: v('--status-good'), warning: v('--status-warning'), serious: v('--status-serious'), critical: v('--status-critical'),
        series: [], seq: [],
      };
      for (let i = 1; i <= 8; i++) c.series.push(v('--series-' + i));
      for (let i = 0; i <= 7; i++) c.seq.push(v('--seq-' + i));
      c.seqRgb = c.seq.map(hexToRgb);
      this.c = c;
      this.font = getComputedStyle(document.body).fontFamily || this.font;
      this.dark = (document.documentElement.dataset.theme || '') === 'dark' ||
        (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
      return c;
    },
    /* Map t in [0,1] onto the sequential ramp; returns [r,g,b]. */
    seqColor(t) {
      const stops = this.c.seqRgb;
      const x = util.clamp(t, 0, 1) * (stops.length - 1);
      const i = Math.min(stops.length - 2, Math.floor(x));
      const f = x - i, a = stops[i], b = stops[i + 1];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    },
    withAlpha(hex, alpha) {
      const [r, g, b] = hexToRgb(hex);
      return `rgba(${r},${g},${b},${alpha})`;
    },
  };

  function hexToRgb(hex) {
    const h = String(hex).replace('#', '').trim();
    if (h.length === 3) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  /* Relative luminance, used to pick legible ink on colored cells. */
  function luminance(rgb) {
    const lin = rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  /* ---------------- canvas helpers ---------------- */
  const canvas = {
    /* Size a canvas to its CSS box at device pixel ratio. Returns {w,h,dpr,ctx}. */
    fit(cv) {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const r = cv.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h, dpr, ctx };
    },
    /* Crisp 1px hairline at a CSS coordinate. */
    crisp(v) { return Math.round(v) + 0.5; },
  };

  /* ---------------- tooltip ---------------- */
  const tooltip = {
    /* rows: [{color, value, label}] – values lead, labels follow. Text via textContent. */
    show(tip, wrap, px, py, header, rows) {
      tip.replaceChildren();
      if (header) tip.append(util.el('div', { class: 'tt-head', text: header }));
      for (const r of rows) {
        const key = util.el('span', { class: 'tt-key' });
        key.style.background = r.color || 'transparent';
        tip.append(util.el('div', { class: 'tt-row' }, [
          key,
          util.el('span', { class: 'tt-val', text: r.value }),
          util.el('span', { class: 'tt-lab', text: r.label }),
        ]));
      }
      tip.hidden = false;
      const W = wrap.clientWidth, H = wrap.clientHeight;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = px + 14, y = py + 12;
      if (x + tw > W - 4) x = px - tw - 14;
      if (y + th > H - 4) y = H - th - 4;
      tip.style.left = Math.max(4, x) + 'px';
      tip.style.top = Math.max(4, y) + 'px';
    },
    hide(tip) { tip.hidden = true; },
  };

  /* ---------------- minimal ZIP (stored, no compression) ---------------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* files: [{name, data: Uint8Array|string}] -> Blob */
  function makeZip(files, date) {
    const enc = new TextEncoder();
    const d = date || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  /* Marker kinds shared by the averaging views. Control markers log what the
     app did (runs starting, signal-check steps) and are never averaged;
     artifact markers are averaged only when chosen explicitly. */
  const markerKinds = {
    control: /^(ssvep_(free|cued|calib)_(start|stop|end)|ssvep_flicker_on|check_(open|closed|jaw))$/,
    artifact: /^blink$/,
  };

  NP.markerKinds = markerKinds;
  NP.RingBuffer = RingBuffer;
  NP.util = util;
  NP.theme = theme;
  NP.canvas = canvas;
  NP.tooltip = tooltip;
  NP.color = { hexToRgb, luminance };
  NP.zip = { makeZip, crc32 };
})(window.NP);
