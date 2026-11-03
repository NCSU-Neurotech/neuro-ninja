/* Fruit (Classic and Zen): fruit lands on a tile, look at it to slice it.
   Bombs land too in Classic: looking at one costs a life. */
(function (NP) {
  'use strict';
  const { rand } = NP.gameUtil;

  const FRUITS = [
    { e: '🍉', juice: '#ef3b55' }, { e: '🍊', juice: '#ff9a1f' }, { e: '🍎', juice: '#e8283a' },
    { e: '🍋', juice: '#ffe14a' }, { e: '🍇', juice: '#9b59d0' }, { e: '🍍', juice: '#f7c843' },
    { e: '🥝', juice: '#8bc34a' }, { e: '🍑', juice: '#ffad7a' }, { e: '🍓', juice: '#e53950' },
    { e: '🍌', juice: '#ffe36e' }, { e: '🥭', juice: '#ffb340' }, { e: '🍐', juice: '#c6e05a' },
  ];
  const BOMB_E = '💣';
  const FIRST_SPAWN_S = 2.2;   // let the first decision window fill
  const ARRIVE_S = 0.55;
  const BOMB_GRACE_S = 1.0;    // a bomb can't go off in its first second: time to look away
  const ZEN_S = 90;
  const LIVES = 3;

  class FruitMode {
    constructor(game, variant) {
      this.g = game;
      this.zen = variant === 'zen';
      this.items = [];
      this.nextSpawn = FIRST_SPAWN_S;
      this.cooldown = [0, 0, 0, 0];
      this.lastPick = { k: -1, t: -9 };
      this.lives = LIVES;
      this.hint = 'Look straight at a fruit to slice it';
      this.countdownText = 'Look straight at the fruit you want to slice';
      this.hud = this.zen ? { timer: ZEN_S } : { lives: LIVES, maxLives: LIVES };
      this.stats = { slices: 0, quick: 0, missed: 0, bombsHit: 0, bombsDodged: 0, whiffs: 0, times: [] };
      this.keepItem = (it) => it.state !== 'gone';
    }

    /* ---------------- difficulty ---------------- */
    get level() { return Math.floor(this.stats.slices / 8); }
    get hang() { return this.zen ? 6.5 : Math.max(3.8, 7 - 0.35 * this.level); }
    get spawnGap() { return this.zen ? 2.6 : Math.max(1.6, 3.6 - 0.25 * this.level); }
    get maxItems() {
      const n = this.stats.slices;
      return n < 3 ? 1 : this.zen ? Math.min(3, 1 + Math.floor(n / 4)) : Math.min(3, 2 + Math.floor(this.level / 3));
    }
    get bombChance() { return this.zen || this.stats.slices < 6 ? 0 : Math.min(0.3, 0.12 + 0.03 * this.level); }

    live(it) { return it.state === 'arriving' || it.state === 'sitting'; }
    isLive(k) { return this.items.some((i) => i.k === k && this.live(i)); }
    sittingAt(k) { for (const i of this.items) if (i.k === k && i.state === 'sitting') return i; return null; }
    bobY(it) { return Math.sin(this.g.gt * 2 * Math.PI * 0.6 + it.bob) * this.g.size * 0.05; }

    update(gdt) {
      const g = this.g;
      if (this.zen) {
        this.hud.timer = ZEN_S - g.gt;
        if (g.gt >= ZEN_S) { g.endGame('time'); return; }
      }
      if (g.gt >= this.nextSpawn) {
        this.spawn();
        this.nextSpawn = g.gt + this.spawnGap * rand(0.85, 1.15);
      }
      for (const it of this.items) {
        if (it.state === 'arriving') {
          it.p += gdt / ARRIVE_S;
          if (it.p >= 1) { it.state = 'sitting'; it.sitStart = g.gt; }
        } else if (it.state === 'sitting' && g.gt - it.sitStart >= it.hang && g.state === 'playing') {
          this.expire(it);
        }
      }
    }

    updateFx(fdt) {
      const g = this.g, grav = g.dims.h * 2.4;
      for (const it of this.items) {
        if (it.state === 'falling') {
          it.vy += grav * fdt; it.x += it.vx * fdt; it.y += it.vy * fdt; it.a += it.spin * fdt;
          if (it.y > g.dims.h + g.size) it.state = 'gone';
        } else if (it.state === 'fizzle') {
          it.fade -= fdt / 0.45;
          if (it.fade <= 0) it.state = 'gone';
        }
      }
      NP.gameUtil.compact(this.items, this.keepItem);
    }

    spawn() {
      const g = this.g;
      const live = this.items.filter((it) => this.live(it));
      if (live.length >= this.maxItems) return;
      const busy = live.map((it) => it.k);
      const free = [0, 1, 2, 3].filter((k) => !busy.includes(k) && g.gt >= this.cooldown[k]);
      if (!free.length) return;
      let type = 'fruit', pool = free;
      if (Math.random() < this.bombChance && !live.some((it) => it.type === 'bomb')) {
        // Never under the eyes: not where the decoder is leaning, nor where
        // the last pick landed (the player is probably still looking there).
        const safe = free.filter((k) => k !== g.aim.k && !(k === this.lastPick.k && g.gt - this.lastPick.t < 3));
        if (safe.length) { type = 'bomb'; pool = safe; }
      }
      const k = pool[Math.floor(Math.random() * pool.length)];
      const r = g.rects[k];
      this.items.push({
        k, type, fruit: Math.floor(Math.random() * FRUITS.length),
        state: 'arriving', p: 0, t0: g.gt, sitStart: 0, hang: this.hang,
        x0: r.cx + rand(-0.4, 0.4) * r.s, y0: g.dims.h + g.size,
        x: 0, y: 0, a: rand(-0.6, 0.6), spin: rand(-5, 5), bob: rand(0, 6.28), vx: 0, vy: 0, fade: 1,
      });
    }

    onPick(k) {
      const g = this.g;
      this.cooldown[k] = g.gt + 1.5;
      this.lastPick = { k, t: g.gt };
      const it = this.items.find((i) => i.k === k && this.live(i));
      if (!it) { this.whiff(k, 'Nothing there'); return; }
      if (it.type === 'bomb') {
        if (g.gt - it.t0 < BOMB_GRACE_S) { this.whiff(k, 'Close one!'); return; }
        this.explode(it);
        return;
      }
      this.slice(it);
    }

    whiff(k, label) {
      const g = this.g, r = g.rects[k];
      this.stats.whiffs++;
      g.ring(k, '154,200,255');
      g.swipe(r.cx, r.cy, rand(-0.9, 0.9), r.s * 1.1, r.s * 0.03, 0.25);
      g.text(r.cx, r.cy, label, 'rgba(230,230,230,1)', 0.5);
      g.sfx.whiff();
    }

    slice(it) {
      const g = this.g, r = g.rects[it.k], size = g.size;
      const held = it.state === 'sitting' ? g.gt - it.sitStart : 0;
      const quick = held < 0.4 * it.hang;
      let pts = quick ? 2 : 1;
      const combo = g.hit();
      const streak = combo % 5 === 0;
      if (streak) pts += 5;
      g.addScore(pts);
      this.stats.slices++;
      if (quick) this.stats.quick++;
      this.stats.times.push(held);
      this.hint = '';
      g.ring(it.k, '120,230,120');
      const fr = FRUITS[it.fruit];
      const cut = rand(-1.1, 1.1);
      const x = it.state === 'sitting' ? r.cx : it.x, y = it.state === 'sitting' ? r.cy + this.bobY(it) : it.y;
      g.halves(g.emoji(fr.e), x, y, cut);
      g.burst(x, y, fr.juice, 26);
      g.swipe(x, y, cut + Math.PI / 2, r.s * 1.25, r.s * 0.05, 0.28);
      g.text(x, y - size * 0.35, quick ? `+${pts} Quick!` : `+${pts}`, 'rgba(255,236,120,1)', 0.9);
      if (streak) g.text(g.dims.w / 2, g.dims.h * 0.42, `${combo} in a row! +5`, 'rgba(255,207,63,1)', 1.4, 1.5);
      it.state = 'gone';
      g.sfx.slice();
      if (streak) g.sfx.streak();
    }

    explode(it) {
      const g = this.g, r = g.rects[it.k];
      this.stats.bombsHit++;
      g.breakCombo();
      g.ring(it.k, '255,120,80');
      g.boom(r.cx, r.cy, r.s * 0.7);
      g.burst(r.cx, r.cy, ['#ff8a3d', '#3b3b3b'], 36, { speed: 1.1, lift: 0, stain: false, life: 0.8 });
      it.state = 'gone';
      g.sfx.bomb();
      if (!this.zen) this.loseLife(r.cx, r.cy, 'Bomb! −1 life');
    }

    loseLife(x, y, label) {
      this.lives--;
      this.hud.lives = this.lives;
      this.g.text(x, y, label, 'rgba(255,110,110,1)', 1.1);
      if (this.lives <= 0) this.g.endGame('lives');
    }

    expire(it) {
      const g = this.g;
      if (it.type === 'bomb') {
        it.state = 'fizzle';
        this.stats.bombsDodged++;
        return;
      }
      it.state = 'falling';
      it.x = g.rects[it.k].cx; it.y = g.rects[it.k].cy + this.bobY(it);
      it.vx = rand(-0.5, 0.5) * g.size; it.vy = -g.size * 0.5;
      this.stats.missed++;
      g.breakCombo();
      g.sfx.miss();
      if (!this.zen) this.loseLife(it.x, it.y, 'Missed! −1 life');
      else g.text(it.x, it.y, 'Missed', 'rgba(255,170,170,1)', 0.8);
    }

    /* ---------------- drawing ---------------- */
    hasContent(k) { return !!this.sittingAt(k); }

    drawContent(ctx, k, r) {
      const g = this.g, it = this.sittingAt(k);
      const spr = it.type === 'bomb' ? g.emoji(BOMB_E) : g.emoji(FRUITS[it.fruit].e);
      const wob = Math.sin(g.gt * 2 * Math.PI * 0.4 + it.bob) * 0.12;
      ctx.translate(r.cx, r.cy + this.bobY(it));
      ctx.rotate(wob);
      ctx.drawImage(spr, -g.size / 2, -g.size / 2, g.size, g.size);
    }

    /* Fruit in flight, falling or fizzling: on top of everything, not flickering. */
    drawWorld(ctx) {
      const g = this.g;
      for (const it of this.items) {
        if (it.state === 'sitting') continue;
        if (it.state === 'arriving') {
          const r = g.rects[it.k], p = Math.min(1, it.p), e = 1 - Math.pow(1 - p, 3);
          it.x = it.x0 + (r.cx - it.x0) * e;
          it.y = it.y0 + (r.cy - it.y0) * e - Math.sin(Math.PI * p) * g.dims.h * 0.06;
        }
        const spr = it.type === 'bomb' ? g.emoji(BOMB_E) : g.emoji(FRUITS[it.fruit].e);
        const a = it.state === 'arriving' ? it.a * (1 - it.p) : it.a;
        const fz = it.state === 'fizzle';
        const x = fz ? g.rects[it.k].cx : it.x, y = fz ? g.rects[it.k].cy : it.y;
        const sc = fz ? 0.6 + 0.4 * it.fade : 1;
        ctx.save();
        ctx.globalAlpha = fz ? Math.max(0, it.fade) : 1;
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.drawImage(spr, -g.size * sc / 2, -g.size * sc / 2, g.size * sc, g.size * sc);
        ctx.restore();
      }
    }

    drawFrame(ctx, k, r) {
      const it = this.sittingAt(k);
      if (!it) return;
      const left = Math.max(0, 1 - (this.g.gt - it.sitStart) / it.hang);
      ctx.fillStyle = it.type === 'bomb' ? '#8a8a8a' : left > 0.5 ? '#5bd75b' : left > 0.25 ? '#ffc23d' : '#ff5a4f';
      ctx.fillRect(r.x, r.y + r.s + 6, r.s * left, 6);
    }

    summaryRows() {
      const s = this.stats, t = s.times.slice().sort((a, b) => a - b), g = this.g;
      const rows = [
        ['Fruit sliced', s.slices], ['Quick slices', s.quick],
        ['Fruit dropped', s.missed], ['Longest streak', g.maxCombo],
        ['Typical slice time', t.length ? `${t[t.length >> 1].toFixed(1)} s` : '—'],
        ['Picks that hit fruit', g.picks ? `${Math.round((100 * s.slices) / g.picks)}%` : '—'],
      ];
      if (!this.zen) rows.push(['Bombs hit', s.bombsHit], ['Bombs dodged', s.bombsDodged]);
      return rows;
    }
  }

  NP.modes.classic = { cls: FruitMode, variant: 'classic', name: 'Fruit Slice', icon: '🍉', blurb: '3 lives. Slice fruit, avoid bombs. Speeds up as you score.' };
  NP.modes.zen = { cls: FruitMode, variant: 'zen', name: 'Fruit Zen', icon: '🍊', blurb: '90 seconds, no bombs, no lives. Good for warming up.' };
})(window.NP);
