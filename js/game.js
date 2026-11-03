/* Neuro Ninja engine: the part every game mode shares.

   Four tiles sit in the corners of the screen, each flickering at its own
   rate: 12–15 Hz by default, or 7.5–12 Hz (the set that scored 92% and 100%
   in EXG Visualizer+ cued tests). Looking straight at a tile makes the brain
   answer at its rate and the decoder picks it. What a pick *means* is up to
   the mode (js/modes/*.js): slice a fruit, whack a mole, repeat a Simon
   sequence, steer through a maze.

   Why 12–15 Hz by default: alpha (~10 Hz) is strongest when nothing holds
   your attention, which in a game is the time between targets. On the
   simulator, every pick on an empty tile with the 7.5–12 Hz set landed on
   the 10 Hz tile (8 of 8 over two runs); with 12–15 Hz there were half as
   many and none clustered on one tile, at the same speed.

   Stimulus rules carried over from EXG Visualizer+:
   - Luminance follows L = ½(1 + sin 2πft) at every frame's own timestamp,
     converted to sRGB, so the light (not the pixel value) is sinusoidal and
     a dropped frame doesn't shift the phase.
   - Whatever a mode draws on a tile flickers with it. People look at the
     thing on the tile, and the centre of gaze is where most of the response
     comes from. The tile is drawn white, the mode's content on top, then
     black at alpha 1 − g, which multiplies every colour by g = sRGB(L):
     linear light then follows L for the content's colours as well.
   - Frequencies are placed so neighbouring rates never sit side by side.
   - Nothing else flashes: effects grow and fade, never strobe. The frame
     loop avoids allocating, so the garbage collector has little reason to
     pause mid-flicker.

   A mode implements:
     begin()                    first time the game starts (after the countdown)
     update(gdt)                game time moves on (only while playing)
     updateFx?(fdt)             effects move on (also while the game is ending)
     isLive(k)                  can tile k be picked right now?
     onPick(k)                  the decoder picked tile k
     hasContent?(k), drawContent?(ctx, k, r)   drawn inside the tile, flickers with it
     tileStatic?(k)             a colour for tile k while the flicker is off
     drawWorld?(ctx)            drawn over the board, outside the tiles
     drawFrame?(ctx, k, r)      drawn around tile k (bars, labels, frames)
     background?(g, w, h, rects)
     layout?()                  sizes changed
     hud                        { lives, maxLives } | { timer } and optional label
     hint, hintY?               a line of text for the player
     summaryRows()              [[label, value], …] for the results screen
     onFlickerStart?()          the flicker (re)started, after the countdown or a pause
     onScores?(raw, z, total)   every decoder window's scores (calibration uses these)
     noScore, title, result?()  tests and calibration: a title instead of a score,
                                and their own heading and big number on the results screen
     endText?                   what to say when it ends
   and calls game.setFlicker(on) when its rules need the tiles still. */
(function (NP) {
  'use strict';

  const toSrgb = (L) => (L <= 0.0031308 ? 12.92 * L : 1.055 * Math.pow(L, 1 / 2.4) - 0.055);
  const GREY = Array.from({ length: 256 }, (_, v) => `rgb(${v},${v},${v})`);
  const LEVEL_HALF = Math.round(255 * toSrgb(0.5));   // steady tile while nothing flickers

  /* Two sets of rates. CCA scores both phases of every reference, so phase
     plays no part here and all targets start at 0. */
  const RATE_SETS = {
    alphafree: [12, 13, 14, 15],      // clear of the 8–13 Hz alpha rhythm
    visualizer: [7.5, 60 / 7, 10, 12], // the set that scored 92% and 100% in cued tests
  };
  const targetsFor = (key) => (RATE_SETS[key] || RATE_SETS.alphafree).map((f) => ({ f, phase: 0 }));
  const SPOTS = [[0, 0], [1, 1], [0, 1], [1, 0]];   // EXG Visualizer+ spread order: k0 TL, k1 BR, k2 BL, k3 TR

  const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  const HUD_FONT = '"Arial Black","Segoe UI Black","Segoe UI",Impact,sans-serif';
  const UI_FONT = '"Segoe UI",system-ui,-apple-system,sans-serif';
  const COUNTDOWN_MS = 3000;
  const NO_DASH = [];

  const rand = (a, b) => a + Math.random() * (b - a);

  /* Square for each corner, as large as fits while leaving room between
     neighbours (same idea as EXG Visualizer+'s spread layout). */
  function tileRects(w, h) {
    const pad = Math.round(Math.max(16, Math.min(w, h) * 0.025));
    const bar = 20;
    const availW = Math.max(60, w - 2 * pad), availH = Math.max(60, h - 2 * pad - bar);
    const most = Math.min(availW, availH) * 0.42;
    let s = most;
    for (let pass = 0; pass < 5; pass++) s = Math.min(most, Math.min(availW - s, availH - s) * 0.72);
    s = Math.max(60, Math.floor(s));
    return SPOTS.map(([px, py]) => {
      const x = Math.round(pad + px * (availW - s)), y = Math.round(pad + py * (availH - s));
      return { x, y, s, cx: x + s / 2, cy: y + s / 2, r: Math.round(s * 0.06) };
    });
  }

  function emojiSprite(ch, px) {
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `${Math.round(px * 0.8)}px ${EMOJI_FONT}`;
    g.fillText(ch, px / 2, px / 2 + px * 0.05);
    return c;
  }

  function seeded(seed) {
    return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  }

  /* A recessed slot under each tile and its bar. */
  function drawSlots(g, rects, shade) {
    for (const r of rects) {
      g.fillStyle = shade || 'rgba(0,0,0,0.55)';
      g.beginPath(); g.roundRect(r.x - 7, r.y - 7, r.s + 14, r.s + 14, r.r + 6); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(r.x, r.y + r.s + 6, r.s, 6);
    }
  }

  function vignette(g, w, h, strength) {
    const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(0,0,0,${strength})`);
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);
  }

  /* Dark wooden board: the default background. */
  function woodBackground(g, w, h, rects) {
    const rnd = seeded(1234);
    const plank = Math.max(90, Math.round(w / 11));
    for (let x = 0; x < w; x += plank) {
      const l = 17 + rnd() * 6;
      g.fillStyle = `hsl(${24 + rnd() * 6}, ${38 + rnd() * 10}%, ${l}%)`;
      g.fillRect(x, 0, plank, h);
      g.strokeStyle = 'rgba(255,220,180,0.035)';
      g.lineWidth = 1;
      for (let k = 0; k < 14; k++) {
        const gx = x + rnd() * plank, amp = 2 + rnd() * 6, fr = 0.004 + rnd() * 0.01, ph = rnd() * 6.28;
        g.beginPath();
        for (let y = 0; y <= h; y += 12) g.lineTo(gx + amp * Math.sin(y * fr + ph), y);
        g.stroke();
      }
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(x + plank - 3, 0, 3, h);
    }
    vignette(g, w, h, 0.55);
    drawSlots(g, rects);
  }

  function compact(arr, keep) {
    let j = 0;
    for (let i = 0; i < arr.length; i++) if (keep(arr[i])) arr[j++] = arr[i];
    arr.length = j;
  }

  class Game {
    constructor(cv, eeg, sfx) {
      this.cv = cv;
      this.eeg = eeg;
      this.sfx = sfx;
      this.running = false;
      this.state = 'idle';      // idle · countdown · playing · paused · ending · over
      this.hover = -1;
      this.onOver = () => {};
      this.onFlickerStart = () => {};
      this.loop = this.loop.bind(this);
      this.deltas = new Float64Array(60);
      this.dash = [0, 0];
      this.emojiCache = new Map();
      this.halvesFx = []; this.parts = []; this.stains = []; this.texts = []; this.swipes = []; this.booms = []; this.swings = [];
      this.hudCache = { score: -1, scoreStr: '', best: -1, bestStr: '', status: '', statusAt: 0, label: '', timer: -1, timerStr: '' };
      this.keep = {
        half: (hv) => hv.y < this.dims.h + this.size && hv.t < 2.5,
        part: (p) => p.t < p.life,
        stain: (s) => s.t < 9,
        timed: (x) => x.t < x.life,
      };
      this.needsLayout = true;
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { this.needsLayout = true; }).observe(cv);
      window.addEventListener('resize', () => { this.needsLayout = true; });
    }

    get flickering() { return this.state === 'playing' && this.flickerOn; }

    /* ---------------- lifecycle ---------------- */
    start(opts) {
      this.opts = opts;           // {mode, rates, windowS, lineFreq, sim, best}
      this.modeKey = opts.mode;
      this.targets = targetsFor(opts.rates);
      this.score = 0;
      this.combo = 0;
      this.maxCombo = 0;
      this.lastHitT = -9;
      this.gt = 0;
      this.picks = 0;
      this.aim = { k: -1, progress: 0 };
      this.pickRing = null;
      this.flickerOn = false;
      this.flickerWanted = true;
      this.begun = false;
      for (const a of [this.halvesFx, this.parts, this.stains, this.texts, this.swipes, this.booms, this.swings]) a.length = 0;
      this.dropped = 0; this.frames = 0; this.nDeltas = 0; this.iDelta = 0; this.hz = NaN;
      const entry = NP.modes[opts.mode] || NP.modes.classic;
      this.mode = new entry.cls(this, entry.variant);
      this.needsLayout = true;
      this.beginCountdown();
      if (!this.running) { this.running = true; this.lastTs = 0; requestAnimationFrame(this.loop); }
    }

    beginCountdown() {
      // The stage may have just been shown or gone fullscreen: measure again.
      this.needsLayout = true;
      this.state = 'countdown';
      this.countdownUntil = performance.now() + COUNTDOWN_MS;
      this.lastBeep = 4;
    }

    pause() {
      if (this.state !== 'playing' && this.state !== 'countdown') return false;
      this.state = 'paused';
      this.stopFlicker();
      return true;
    }

    resume() {
      if (this.state === 'paused') this.beginCountdown();
    }

    stop() {
      this.state = 'idle';
      this.running = false;
      this.stopFlicker();
    }

    countdownDone(ts) {
      this.state = 'playing';
      this.sfx.go();
      if (!this.begun) { this.begun = true; if (this.mode.begin) this.mode.begin(); }
      if (this.flickerWanted && this.state === 'playing') this.startFlicker(ts);
    }

    /* Modes call this: Simon shows its sequence on still tiles, for example. */
    setFlicker(on) {
      this.flickerWanted = on;
      if (this.state !== 'playing') return;
      if (on && !this.flickerOn) this.startFlicker(this.lastTs || performance.now());
      else if (!on && this.flickerOn) this.stopFlicker();
    }

    startFlicker(ts) {
      this.flickerOn = true;
      this.flickerT0 = ts;
      this.aim = { k: -1, progress: 0 };
      this.eeg.startDecoding({
        targets: this.targets, windowS: this.opts.windowS, lineFreq: this.opts.lineFreq,
        onPick: (k) => this.handlePick(k),
        onAim: (a) => { this.aim = a; },
        isLive: (k) => this.flickering && this.mode.isLive(k),
        calib: this.opts.calib || null,
        onScores: (s, z, total) => { if (this.mode.onScores && this.flickering) this.mode.onScores(s, z, total); },
      });
      if (this.mode.onFlickerStart) this.mode.onFlickerStart();
      this.onFlickerStart();
    }

    stopFlicker() {
      this.flickerOn = false;
      this.aim = { k: -1, progress: 0 };
      this.eeg.stopDecoding();
    }

    handlePick(k) {
      if (!this.flickering) return;
      this.picks++;
      this.mode.onPick(k);
    }

    endGame(reason) {
      if (this.state === 'ending' || this.state === 'over') return;
      this.state = 'ending';
      this.endReason = reason;
      this.endAt = performance.now() + 1300;
      this.flickerWanted = false;
      this.stopFlicker();
      if (reason === 'time' || reason === 'done') this.sfx.win();
    }

    tileAt(x, y) {
      if (!this.rects) return -1;
      for (let k = 0; k < this.rects.length; k++) {
        const r = this.rects[k];
        if (x >= r.x && x <= r.x + r.s && y >= r.y && y <= r.y + r.s) return k;
      }
      return -1;
    }

    /* ---------------- helpers for modes ---------------- */
    emoji(ch) {
      let c = this.emojiCache.get(ch);
      if (!c) { c = emojiSprite(ch, this.spritePx); this.emojiCache.set(ch, c); }
      return c;
    }
    addScore(p) { this.score += p; }
    hit() { this.combo++; this.maxCombo = Math.max(this.maxCombo, this.combo); this.lastHitT = this.gt; return this.combo; }
    breakCombo() { this.combo = 0; }
    ring(k, rgb) { this.pickRing = { k, t: this.gt, color: rgb }; }
    text(x, y, s, color, life, scale) { this.texts.push({ x, y, s, color, t: 0, life, scale: scale || 1 }); }
    swipe(x, y, a, len, w, life) { this.swipes.push({ x, y, a, len, w, t: 0, life }); }
    boom(x, y, R) { this.booms.push({ x, y, R, t: 0, life: 0.8 }); }
    swing(spr, x, y, size) { this.swings.push({ spr, x, y, size, t: 0, life: 0.3 }); }
    burst(x, y, color, n, opts) {
      const o = opts || {}, size = this.size, sp = o.speed || 1;
      for (let i = 0; i < n; i++) {
        const ang = rand(0, Math.PI * 2), v = size * rand(1, 5.5) * sp;
        this.parts.push({
          x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - (o.lift == null ? size : o.lift),
          r: rand(2, 7) * size / 120, color: Array.isArray(color) ? color[i % color.length] : color,
          t: 0, life: rand(0.5, 1) * (o.life || 1), stain: o.stain !== false, gravity: o.gravity == null ? 0.6 : o.gravity,
        });
      }
    }
    halves(spr, x, y, cut) {
      const size = this.size, sp = size * 2.2;
      for (const side of [-1, 1]) {
        this.halvesFx.push({
          spr, side, x, y, a: cut,
          vx: side * Math.cos(cut) * sp * rand(0.8, 1.1), vy: side * Math.sin(cut) * sp - size * rand(2.5, 3.5),
          spin: side * rand(2, 5), t: 0,
        });
      }
    }

    /* ---------------- frame loop ---------------- */
    layout() {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const rc = this.cv.getBoundingClientRect();
      const w = Math.max(1, Math.round(rc.width)), h = Math.max(1, Math.round(rc.height));
      this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
      const ctx = this.cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.rects = tileRects(w, h);
      this.size = Math.round(this.rects[0].s * 0.66);
      const px = Math.round(this.size * dpr);
      if (this.spritePx !== px) { this.emojiCache.clear(); this.spritePx = px; }
      const m = Math.min(w, h);
      this.dims = {
        w, h, dpr, ctx, m,
        scoreFont: `${Math.round(m * 0.085)}px ${HUD_FONT}`,
        midFont: `${Math.round(m * 0.04)}px ${HUD_FONT}`,
        smallFont: `600 ${Math.round(Math.max(12, m * 0.017))}px ${UI_FONT}`,
        hintFont: `600 ${Math.round(Math.max(15, m * 0.026))}px ${UI_FONT}`,
        countFont: `${Math.round(m * 0.2)}px ${HUD_FONT}`,
        floatFont: `${Math.round(m * 0.035)}px ${HUD_FONT}`,
        uiFont: UI_FONT, hudFont: HUD_FONT,
      };
      // Free space between the left and right columns of tiles, below the HUD.
      const r0 = this.rects[0], r3 = this.rects[3];
      const gap = Math.max(16, m * 0.03);
      this.centerBox = { x: r0.x + r0.s + gap, y: m * 0.25, w: Math.max(40, r3.x - gap - (r0.x + r0.s + gap)), h: Math.max(40, h - m * 0.25 - m * 0.09) };
      if (this.mode && this.mode.layout) this.mode.layout();
      const bg = document.createElement('canvas');
      bg.width = Math.round(w * dpr); bg.height = Math.round(h * dpr);
      const g = bg.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.mode && this.mode.background) this.mode.background(g, w, h, this.rects); else woodBackground(g, w, h, this.rects);
      this.bg = bg;
    }

    loop(ts) {
      if (!this.running) return;
      if (this.needsLayout || !this.dims) { this.needsLayout = false; this.layout(); }
      const d = this.lastTs ? ts - this.lastTs : 0;
      this.lastTs = ts;
      if (d > 0) this.measure(d);
      const dt = Math.min(0.1, d / 1000);

      if (this.state === 'countdown') {
        const left = this.countdownUntil - performance.now();
        const n = Math.ceil(left / 1000);
        if (n < this.lastBeep && n >= 1) { this.lastBeep = n; this.sfx.tick(); }
        if (left <= 0) this.countdownDone(ts);
      }
      if (this.state === 'ending' && performance.now() >= this.endAt) {
        this.state = 'over';
        this.running = false;
        this.render(ts);
        this.onOver(this.summary());
        return;
      }
      const live = this.state === 'playing' || this.state === 'ending';
      this.update(this.state === 'playing' ? dt : 0, live ? dt : 0);
      this.render(ts);
      if (this.flickering) this.eeg.maybeTick(performance.now());
      requestAnimationFrame(this.loop);
    }

    measure(d) {
      this.deltas[this.iDelta] = d;
      this.iDelta = (this.iDelta + 1) % this.deltas.length;
      if (this.nDeltas < this.deltas.length) this.nDeltas++;
      if (++this.frames % 30 === 0 && this.nDeltas >= 10) {
        const s = Array.prototype.slice.call(this.deltas, 0, this.nDeltas).sort((a, b) => a - b);
        this.hz = 1000 / s[s.length >> 1];
      }
      if (this.flickering && this.hz > 0 && d > 1500 / this.hz) this.dropped += Math.round((d * this.hz) / 1000) - 1;
    }

    /* gdt advances the game (spawns, timers); fdt moves effects. */
    update(gdt, fdt) {
      const D = this.dims;
      if (gdt > 0) {
        this.gt += gdt;
        this.mode.update(gdt);
      }
      if (fdt > 0) {
        const g = D.h * 2.4;
        if (this.mode.updateFx) this.mode.updateFx(fdt);
        for (const hv of this.halvesFx) { hv.vy += g * fdt; hv.x += hv.vx * fdt; hv.y += hv.vy * fdt; hv.a += hv.spin * fdt; hv.t += fdt; }
        for (const p of this.parts) {
          p.vy += g * p.gravity * fdt; p.x += p.vx * fdt; p.y += p.vy * fdt; p.vx *= 1 - 1.5 * fdt; p.t += fdt;
          if (p.t >= p.life && p.stain && this.stains.length < 140 && this.tileAt(p.x, p.y) < 0) {
            this.stains.push({ x: p.x, y: p.y, r: p.r * rand(1.2, 2.4), color: p.color, t: 0 });
          }
        }
        for (const s of this.stains) s.t += fdt;
        for (const t of this.texts) t.t += fdt;
        for (const s of this.swipes) s.t += fdt;
        for (const b of this.booms) b.t += fdt;
        for (const s of this.swings) s.t += fdt;
      }
      // In-place compaction: no new arrays in the frame loop.
      const kp = this.keep;
      compact(this.halvesFx, kp.half);
      compact(this.parts, kp.part);
      compact(this.stains, kp.stain);
      compact(this.texts, kp.timed);
      compact(this.swipes, kp.timed);
      compact(this.booms, kp.timed);
      compact(this.swings, kp.timed);
    }

    /* ---------------- drawing ---------------- */
    render(ts) {
      const D = this.dims, ctx = D.ctx;
      ctx.globalAlpha = 1;
      ctx.drawImage(this.bg, 0, 0, D.w, D.h);
      for (const s of this.stains) {
        ctx.globalAlpha = 0.5 * Math.min(1, (9 - s.t) / 3);
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      const t = this.flickerOn ? (ts - this.flickerT0) / 1000 : 0;
      for (let k = 0; k < 4; k++) this.drawTile(ctx, k, t);
      if (this.mode.drawWorld) this.mode.drawWorld(ctx);
      for (let k = 0; k < 4; k++) this.drawFrame(ctx, k);
      this.drawEffects(ctx);
      this.drawHud(ctx);
      if (this.state === 'countdown') this.drawCountdown(ctx);
    }

    drawTile(ctx, k, t) {
      const r = this.rects[k], mode = this.mode;
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.s, r.s, r.r);
      if (!this.flickerOn && mode.tileStatic) {
        const c = mode.tileStatic(k);
        if (c) { ctx.fillStyle = c; ctx.fill(); return; }
      }
      const level = this.flickerOn
        ? Math.round(255 * toSrgb(0.5 * (1 + Math.sin(2 * Math.PI * this.targets[k].f * t + this.targets[k].phase))))
        : LEVEL_HALF;
      if (!(mode.hasContent && mode.hasContent(k))) { ctx.fillStyle = GREY[level]; ctx.fill(); return; }
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.save();
      ctx.clip();
      mode.drawContent(ctx, k, r);
      ctx.restore();
      // The path is still the tile (paths aren't part of the saved state).
      ctx.globalAlpha = 1 - level / 255;
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    /* Outside the flickering area only: the aim ring, the pick ring and the
       mode's own bars and frames never change the light inside a tile. */
    drawFrame(ctx, k) {
      const r = this.rects[k], o = 9;
      if (this.flickering && this.aim.k === k && this.aim.progress > 0) {
        const per = 4 * (r.s + 2 * o);
        this.dash[0] = per * this.aim.progress; this.dash[1] = per;
        ctx.setLineDash(this.dash);
        ctx.strokeStyle = 'rgba(160,210,255,0.95)';
        ctx.lineWidth = 6;
        ctx.strokeRect(r.x - o, r.y - o, r.s + 2 * o, r.s + 2 * o);
        ctx.setLineDash(NO_DASH);
      }
      const pr = this.pickRing;
      if (pr && pr.k === k) {
        const age = this.gt - pr.t;
        if (age < 0.5) {
          ctx.strokeStyle = `rgba(${pr.color},${(1 - age / 0.5).toFixed(3)})`;
          ctx.lineWidth = 7;
          ctx.strokeRect(r.x - o, r.y - o, r.s + 2 * o, r.s + 2 * o);
        }
      }
      if (this.mode.drawFrame) this.mode.drawFrame(ctx, k, r);
    }

    drawEffects(ctx) {
      for (const s of this.swipes) {
        const f = 1 - s.t / s.life;
        const dx = Math.cos(s.a) * s.len / 2, dy = Math.sin(s.a) * s.len / 2;
        ctx.strokeStyle = `rgba(235,245,255,${(0.9 * f).toFixed(3)})`;
        ctx.lineWidth = Math.max(1, s.w * f);
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(s.x - dx, s.y - dy); ctx.lineTo(s.x + dx, s.y + dy); ctx.stroke();
      }
      ctx.lineCap = 'butt';
      for (const hv of this.halvesFx) {
        const z = this.size;
        ctx.save();
        ctx.translate(hv.x, hv.y);
        ctx.rotate(hv.a);
        ctx.beginPath();
        ctx.rect(hv.side < 0 ? -z / 2 : 0, -z / 2, z / 2, z);
        ctx.clip();
        ctx.drawImage(hv.spr, -z / 2, -z / 2, z, z);
        ctx.restore();
      }
      for (const s of this.swings) {
        // A hammer swinging down onto its target.
        const f = Math.min(1, s.t / s.life), z = s.size;
        ctx.save();
        ctx.globalAlpha = f < 0.7 ? 1 : (1 - f) / 0.3;
        ctx.translate(s.x + z * 0.35, s.y - z * 0.35);
        ctx.rotate(-1.1 + 1.5 * Math.min(1, f * 1.6));
        ctx.drawImage(s.spr, -z * 0.75, -z * 0.75, z, z);
        ctx.restore();
      }
      for (const p of this.parts) {
        ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      for (const b of this.booms) {
        const f = b.t / b.life;
        ctx.globalAlpha = Math.max(0, 0.75 * (1 - f));
        ctx.fillStyle = f < 0.35 ? '#ffb347' : '#5a4a3f';
        ctx.beginPath(); ctx.arc(b.x, b.y, b.R * (0.3 + 0.9 * Math.sqrt(f)), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      const D = this.dims;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const tx of this.texts) {
        const f = tx.t / tx.life;
        ctx.globalAlpha = Math.max(0, 1 - f * f);
        ctx.font = tx.scale > 1 ? D.midFont : D.floatFont;
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(30,15,5,0.85)';
        const y = tx.y - f * D.m * 0.06;
        ctx.strokeText(tx.s, tx.x, y);
        ctx.fillStyle = tx.color;
        ctx.fillText(tx.s, tx.x, y);
      }
      ctx.globalAlpha = 1;
    }

    drawHud(ctx) {
      const D = this.dims, cx = D.w / 2, hc = this.hudCache, hud = this.mode.hud || {};
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const sy = D.m * 0.035;
      if (this.mode.noScore) {
        // Tests and calibration: a title and a progress line, no score.
        ctx.font = D.midFont;
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(30,15,5,0.9)';
        ctx.strokeText(this.mode.title, cx, sy);
        ctx.fillStyle = '#ffd84a';
        ctx.fillText(this.mode.title, cx, sy);
        ctx.font = D.smallFont;
        ctx.fillStyle = 'rgba(255,240,220,0.85)';
        if (hud.label) ctx.fillText(hud.label, cx, sy + D.m * 0.065);
        this.drawMessages(ctx);
        return;
      }
      ctx.font = D.scoreFont;
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(30,15,5,0.9)';
      // Strings are rebuilt only when their value changes.
      if (hc.score !== this.score) { hc.score = this.score; hc.scoreStr = String(this.score); }
      const best = Math.max(this.opts.best || 0, this.score);
      const label = hud.label || '';
      if (hc.best !== best || hc.label !== label) {
        hc.best = best; hc.label = label;
        hc.bestStr = label ? `Best ${best} · ${label}` : `Best ${best}`;
      }
      ctx.strokeText(hc.scoreStr, cx, sy);
      ctx.fillStyle = '#ffd84a';
      ctx.fillText(hc.scoreStr, cx, sy);
      ctx.font = D.smallFont;
      ctx.fillStyle = 'rgba(255,240,220,0.75)';
      ctx.fillText(hc.bestStr, cx, sy + D.m * 0.1);

      const ly = sy + D.m * 0.135, xs = D.m * 0.022;
      if (hud.maxLives) {
        for (let i = 0; i < hud.maxLives; i++) {
          const x = cx + (i - (hud.maxLives - 1) / 2) * xs * 3;
          const lost = i >= hud.lives;
          ctx.strokeStyle = lost ? '#ff4d4d' : 'rgba(255,240,220,0.35)';
          ctx.lineWidth = lost ? 5 : 3;
          ctx.beginPath();
          ctx.moveTo(x - xs, ly); ctx.lineTo(x + xs, ly + 2 * xs);
          ctx.moveTo(x + xs, ly); ctx.lineTo(x - xs, ly + 2 * xs);
          ctx.stroke();
        }
      } else if (hud.timer != null) {
        const left = Math.max(0, Math.ceil(hud.timer));
        if (hc.timer !== left) { hc.timer = left; hc.timerStr = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; }
        ctx.font = D.midFont;
        ctx.fillStyle = left <= 10 ? '#ff8a7a' : '#f5ead9';
        ctx.fillText(hc.timerStr, cx, ly - D.m * 0.005);
      }

      if (this.combo >= 2 && this.gt - this.lastHitT < 2.5 && !this.mode.noCombo) {
        ctx.font = D.midFont;
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = Math.min(1, 2.5 - (this.gt - this.lastHitT));
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(30,15,5,0.9)';
        ctx.strokeText(`Combo ×${this.combo}`, cx, D.h * 0.5);
        ctx.fillStyle = '#ffcf3f';
        ctx.fillText(`Combo ×${this.combo}`, cx, D.h * 0.5);
        ctx.globalAlpha = 1;
      }
      this.drawMessages(ctx);
    }

    /* The hint line and the status line at the bottom. */
    drawMessages(ctx) {
      const D = this.dims, cx = D.w / 2, hc = this.hudCache;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = D.hintFont;
      let msg = '';
      if (this.state === 'playing') {
        if (this.flickerOn && this.aim.noSignal) msg = 'No usable EEG channel: check the electrodes';
        else if (this.flickerOn && this.aim.filling != null && this.aim.filling < 1) msg = 'Reading your brainwaves…';
        else msg = this.mode.hint || '';
      } else if (this.state === 'ending') {
        msg = this.mode.endText || (this.endReason === 'time' ? 'Time!' : this.endReason === 'done' ? 'Well done!' : 'Game over');
      }
      if (msg) {
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(30,15,5,0.7)';
        const hy = this.mode.hintY || D.h * 0.62;
        ctx.strokeText(msg, cx, hy);
        ctx.fillStyle = 'rgba(255,245,230,0.95)';
        ctx.fillText(msg, cx, hy);
      }
      ctx.font = D.smallFont;
      ctx.fillStyle = 'rgba(255,240,220,0.45)';
      ctx.textBaseline = 'bottom';
      const now = performance.now();
      if (now - hc.statusAt > 500) {
        hc.statusAt = now;
        const ch = this.eeg.usableChans.length;
        const hz = this.hz > 0 ? ` · ${Math.round(this.hz)} Hz screen` : '';
        hc.status = `${this.opts.sim ? 'Simulator: point at a tile to look at it' : `EEG ${ch} channel${ch === 1 ? '' : 's'}`}${hz}${this.opts.calib ? ' · calibrated' : ''}${this.dropped ? ` · ${this.dropped} late frames` : ''} · Esc pauses`;
      }
      ctx.fillText(hc.status, cx, D.h - D.m * 0.02);
    }

    drawCountdown(ctx) {
      const D = this.dims, left = Math.max(0, this.countdownUntil - performance.now());
      const n = Math.max(1, Math.ceil(left / 1000)), frac = (left % 1000) / 1000;
      const cx = D.w / 2, cy = D.h / 2, R = D.m * 0.15;
      ctx.fillStyle = 'rgba(15,8,4,0.78)';
      ctx.beginPath(); ctx.arc(cx, cy, R + 16, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#ffd84a';
      ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#fff6e6';
      ctx.font = D.countFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n), cx, cy + D.m * 0.01);
      ctx.font = D.hintFont;
      ctx.fillStyle = 'rgba(255,240,220,0.85)';
      ctx.fillText(this.mode.countdownText || 'Look straight at the tile you want', cx, cy + R + D.m * 0.06);
    }

    summary() {
      return {
        mode: this.modeKey, reason: this.endReason, score: this.score, picks: this.picks,
        maxCombo: this.maxCombo, seconds: this.gt, dropped: this.dropped,
        rows: this.mode.summaryRows ? this.mode.summaryRows() : [],
        // Tests and calibration set their own heading and big number.
        result: this.mode.result ? this.mode.result() : null,
      };
    }
  }

  NP.modes = NP.modes || {};
  NP.Game = Game;
  NP.GAME_RATE_SETS = RATE_SETS;
  NP.gameUtil = { rand, seeded, emojiSprite, compact, drawSlots, vignette, EMOJI_FONT, HUD_FONT, UI_FONT };
})(window.NP);
