/* Whack-a-Mole: moles pop out of the four holes; look at one to whack it
   before it ducks. Golden moles are worth 3. Leave the bunnies alone:
   whacking one costs 5 seconds. 60 seconds, faster as the clock runs down. */
(function (NP) {
  'use strict';
  const U = NP.gameUtil, { rand } = U;

  const DURATION = 60;
  const RISE_S = 0.3, DUCK_S = 0.3, BONK_S = 0.45;
  const GRACE_S = 1.0;          // a bunny can't be whacked in its first second
  const FIRST_S = 2.0;

  /* A cartoon mole, drawn once per size (there is no mole emoji). */
  function moleSprite(px, gold) {
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d'), s = px;
    const body = gold ? '#e8b53a' : '#7b5232', edge = gold ? '#a87a1c' : '#4e321d', face = gold ? '#fff0b8' : '#d3a676';
    g.fillStyle = body;
    g.strokeStyle = edge;
    g.lineWidth = s * 0.025;
    g.beginPath();
    g.ellipse(s / 2, s * 0.6, s * 0.34, s * 0.42, 0, Math.PI, 0);
    g.lineTo(s * 0.84, s);
    g.lineTo(s * 0.16, s);
    g.closePath();
    g.fill(); g.stroke();
    g.fillStyle = face;
    g.beginPath(); g.ellipse(s / 2, s * 0.6, s * 0.19, s * 0.15, 0, 0, Math.PI * 2); g.fill();
    for (const ex of [0.4, 0.6]) {
      g.fillStyle = '#161616';
      g.beginPath(); g.arc(s * ex, s * 0.41, s * 0.045, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(s * ex + s * 0.014, s * 0.395, s * 0.014, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#ff7f9e';
    g.beginPath(); g.ellipse(s / 2, s * 0.53, s * 0.065, s * 0.047, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff';
    g.fillRect(s * 0.474, s * 0.6, s * 0.024, s * 0.055);
    g.fillRect(s * 0.502, s * 0.6, s * 0.024, s * 0.055);
    g.strokeStyle = 'rgba(40,25,15,0.7)';
    g.lineWidth = s * 0.008;
    for (const side of [-1, 1]) {
      for (const dy of [-0.02, 0.015]) {
        g.beginPath(); g.moveTo(s / 2 + side * s * 0.09, s * (0.555 + dy)); g.lineTo(s / 2 + side * s * 0.26, s * (0.53 + dy * 2)); g.stroke();
      }
    }
    g.fillStyle = face;
    for (const px2 of [0.32, 0.68]) { g.beginPath(); g.ellipse(s * px2, s * 0.9, s * 0.1, s * 0.07, 0, 0, Math.PI * 2); g.fill(); }
    if (gold) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath(); g.ellipse(s * 0.36, s * 0.27, s * 0.05, s * 0.025, -0.6, 0, Math.PI * 2); g.fill();
    }
    return c;
  }

  class MolesMode {
    constructor(game) {
      this.g = game;
      this.critters = [];
      this.nextSpawn = FIRST_S;
      this.cooldown = [0, 0, 0, 0];
      this.lastPick = { k: -1, t: -9 };
      this.penalty = 0;
      this.hud = { timer: DURATION };
      this.hint = 'Look at a mole to whack it. Leave the bunnies alone!';
      this.countdownText = 'Look straight at a mole to whack it';
      this.stats = { whacked: 0, golden: 0, missed: 0, bunniesHit: 0, bunniesLeft: 0, times: [] };
      this.keep = (c) => c.state !== 'gone';
    }

    layout() {
      const px = this.g.spritePx;
      if (this.px !== px) { this.px = px; this.mole = moleSprite(px, false); this.gold = moleSprite(px, true); }
    }

    background(g, w, h, rects) {
      const stripe = Math.max(60, Math.round(w / 12));
      for (let x = 0, i = 0; x < w; x += stripe, i++) { g.fillStyle = i % 2 ? '#3d7a2c' : '#468833'; g.fillRect(x, 0, stripe, h); }
      const rnd = U.seeded(77);
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = rnd() < 0.5 ? 'rgba(20,60,10,0.28)' : 'rgba(180,230,120,0.12)';
        g.fillRect(rnd() * w, rnd() * h, 2, 5 + rnd() * 5);
      }
      U.vignette(g, w, h, 0.5);
      U.drawSlots(g, rects, 'rgba(70,42,20,0.9)');
    }

    get timeLeft() { return DURATION - this.g.gt - this.penalty; }
    get progress() { return Math.min(1, this.g.gt / DURATION); }
    get upTime() { return 4.5 - 1.9 * this.progress; }
    get maxUp() { return this.g.gt < 12 ? 1 : 2; }

    live(c) { return c.state === 'rising' || c.state === 'up'; }
    at(k) { for (const c of this.critters) if (c.k === k && c.state !== 'gone') return c; return null; }
    isLive(k) { const c = this.at(k); return !!c && this.live(c); }

    update(gdt) {
      const g = this.g;
      this.hud.timer = this.timeLeft;
      if (this.timeLeft <= 0) { g.endGame('time'); return; }
      if (g.gt >= this.nextSpawn) {
        if (this.critters.filter((c) => this.live(c)).length < this.maxUp) this.spawn();
        this.nextSpawn = g.gt + rand(0.5, 1.2);
      }
      for (const c of this.critters) {
        c.t += gdt;
        if (c.state === 'rising' && c.t >= RISE_S) { c.state = 'up'; c.t = 0; }
        else if (c.state === 'up' && c.t >= c.up) { this.duck(c); }
        else if (c.state === 'ducking' && c.t >= DUCK_S) { c.state = 'gone'; this.cooldown[c.k] = g.gt + 1.0; }
        else if (c.state === 'bonked' && c.t >= BONK_S) { c.state = 'gone'; this.cooldown[c.k] = g.gt + 1.0; }
      }
      U.compact(this.critters, this.keep);
    }

    spawn() {
      const g = this.g;
      const free = [0, 1, 2, 3].filter((k) => !this.at(k) && g.gt >= this.cooldown[k]);
      if (!free.length) return;
      let type = Math.random() < 0.1 ? 'gold' : 'mole', pool = free;
      if (g.gt > 8 && Math.random() < 0.16) {
        // Same fairness rule as bombs: never where the player is looking.
        const safe = free.filter((k) => k !== g.aim.k && !(k === this.lastPick.k && g.gt - this.lastPick.t < 2.5));
        if (safe.length) { type = 'bunny'; pool = safe; }
      }
      const k = pool[Math.floor(Math.random() * pool.length)];
      this.critters.push({ k, type, state: 'rising', t: 0, born: g.gt, upAt: g.gt + RISE_S, up: this.upTime * (type === 'gold' ? 0.75 : 1) });
    }

    duck(c) {
      c.state = 'ducking';
      c.t = 0;
      if (c.type === 'bunny') { this.stats.bunniesLeft++; return; }
      this.stats.missed++;
      this.g.breakCombo();
    }

    onPick(k) {
      const g = this.g, c = this.at(k), r = g.rects[k];
      this.lastPick = { k, t: g.gt };
      if (!c || !this.live(c)) return;
      if (c.type === 'bunny') {
        if (g.gt - c.born < GRACE_S) { g.text(r.cx, r.cy, 'Close one!', 'rgba(230,230,230,1)', 0.6); return; }
        this.penalty += 5;
        this.stats.bunniesHit++;
        g.breakCombo();
        g.ring(k, '255,110,110');
        g.text(r.cx, r.cy - g.size * 0.3, 'Not the bunny! −5 s', 'rgba(255,120,120,1)', 1.2);
        g.sfx.bad();
        c.state = 'ducking'; c.t = 0;
        return;
      }
      const held = Math.max(0, g.gt - c.upAt);
      const fast = held < 0.4 * c.up;
      let pts = (c.type === 'gold' ? 3 : 1) + (fast ? 1 : 0);
      const combo = g.hit();
      const streak = combo % 5 === 0;
      if (streak) pts += 3;
      g.addScore(pts);
      this.stats.whacked++;
      if (c.type === 'gold') this.stats.golden++;
      this.stats.times.push(held);
      this.hint = '';
      c.state = 'bonked'; c.t = 0;
      g.ring(k, c.type === 'gold' ? '255,215,80' : '120,230,120');
      g.swing(g.emoji('🔨'), r.cx, r.y + r.s * 0.4, g.size * 0.9);
      g.burst(r.cx, r.y + r.s * 0.35, ['#fff6a8', '#ffd84a', '#ffffff'], 16, { speed: 0.7, lift: g.size * 0.6, stain: false, gravity: 0.25, life: 0.7 });
      g.text(r.cx, r.y + r.s * 0.2, `+${pts}${c.type === 'gold' ? ' Golden!' : fast ? ' Fast!' : ''}`, 'rgba(255,236,120,1)', 0.9);
      if (streak) g.text(g.dims.w / 2, g.dims.h * 0.42, `${combo} in a row! +3`, 'rgba(255,207,63,1)', 1.4, 1.5);
      g.sfx.bonk();
      if (streak) g.sfx.streak();
    }

    /* ---------------- drawing ---------------- */
    hasContent() { return true; }   // the hole is always there

    upAmount(c) {
      if (c.state === 'rising') return c.t / RISE_S;
      if (c.state === 'ducking') return 1 - c.t / DUCK_S;
      return 1;
    }

    drawContent(ctx, k, r) {
      const g = this.g, c = this.at(k);
      const holeY = r.y + r.s * 0.76, rx = r.s * 0.37, ry = r.s * 0.1;
      ctx.fillStyle = '#2e1c10';
      ctx.beginPath(); ctx.ellipse(r.cx, holeY, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      if (c) {
        const z = g.size * 0.95, up = this.upAmount(c);
        const spr = c.type === 'bunny' ? g.emoji('🐰') : c.type === 'gold' ? this.gold : this.mole;
        ctx.save();
        ctx.beginPath(); ctx.rect(r.x, r.y, r.s, holeY - r.y); ctx.clip();
        if (c.state === 'bonked') {
          const sq = 1 - 0.35 * Math.min(1, c.t / 0.12);
          ctx.drawImage(spr, r.cx - z / 2, holeY + z * 0.08 - z * sq, z, z * sq);
        } else {
          ctx.drawImage(spr, r.cx - z / 2, holeY + z * 0.08 - z * up, z, z);
        }
        ctx.restore();
      }
      ctx.strokeStyle = '#7a5534';
      ctx.lineWidth = ry * 0.7;
      ctx.beginPath(); ctx.ellipse(r.cx, holeY, rx, ry, 0, 0.05, Math.PI - 0.05); ctx.stroke();
    }

    drawWorld(ctx) {
      const g = this.g;
      for (const c of this.critters) {
        if (c.state !== 'bonked') continue;
        const r = g.rects[c.k], z = g.size * 0.45;
        ctx.globalAlpha = Math.max(0, 1 - c.t / BONK_S);
        ctx.drawImage(g.emoji('💫'), r.cx - z / 2, r.y + r.s * 0.12 - z / 2, z, z);
        ctx.globalAlpha = 1;
      }
    }

    drawFrame(ctx, k, r) {
      const c = this.at(k);
      if (!c || c.type === 'bunny' || c.state !== 'up') return;
      const left = Math.max(0, 1 - c.t / c.up);
      ctx.fillStyle = left > 0.5 ? '#5bd75b' : left > 0.25 ? '#ffc23d' : '#ff5a4f';
      ctx.fillRect(r.x, r.y + r.s + 6, r.s * left, 6);
    }

    summaryRows() {
      const s = this.stats, t = s.times.slice().sort((a, b) => a - b), g = this.g;
      const hits = s.whacked + s.bunniesHit;
      return [
        ['Moles whacked', s.whacked], ['Golden moles', s.golden],
        ['Moles missed', s.missed], ['Longest streak', g.maxCombo],
        ['Bunnies bonked', s.bunniesHit], ['Bunnies spared', s.bunniesLeft],
        ['Typical whack time', t.length ? `${t[t.length >> 1].toFixed(1)} s` : '—'],
        ['Picks that hit moles', hits ? `${Math.round((100 * s.whacked) / hits)}%` : '—'],
      ];
    }
  }

  NP.modes.moles = { cls: MolesMode, name: 'Whack-a-Mole', icon: '🔨', blurb: '60 seconds. Whack moles before they duck, golden ones are worth 3. Spare the bunnies.' };
})(window.NP);
