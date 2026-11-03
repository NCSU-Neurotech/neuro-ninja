/* Simon: the tiles light up in a sequence (with the flicker off, so you can
   watch without the decoder reading it), then you repeat it by looking at
   each tile in turn while they flicker. Each round adds one step. Three
   mistakes end the game.

   Every pick here is a cued trial with a known answer, so the results
   screen can report a real accuracy for your brain–computer interface. */
(function (NP) {
  'use strict';

  // Per tile index (k0 top-left, k1 bottom-right, k2 bottom-left, k3 top-right),
  // laid out like the original toy: green and red on top, yellow and blue below.
  const COLORS = [
    { name: 'green', hex: '#2ecc71', rgb: '46,204,113', tone: 392 },
    { name: 'blue', hex: '#3498db', rgb: '52,152,219', tone: 196 },
    { name: 'yellow', hex: '#f1c40f', rgb: '241,196,15', tone: 262 },
    { name: 'red', hex: '#e74c3c', rgb: '231,76,60', tone: 330 },
  ];
  const LIVES = 3;
  const TIMEOUT_S = 15;

  class SimonMode {
    constructor(game) {
      this.g = game;
      this.seq = [];
      this.phase = 'intro';
      this.phaseT = 0;
      this.lit = -1;
      this.idx = 0;
      this.lives = LIVES;
      this.noCombo = true;
      this.hud = { lives: LIVES, maxLives: LIVES, label: 'Length 1' };
      this.countdownText = 'Watch the tiles light up, then look at them in order';
      this.stats = { rounds: 0, longest: 0, correct: 0, wrong: 0, times: [] };
    }

    get hint() {
      if (this.phase === 'show' || this.phase === 'intro') return 'Watch…';
      if (this.phase === 'input') return `Your turn: ${this.idx + 1} of ${this.seq.length}`;
      if (this.phase === 'oops') return `It was ${COLORS[this.seq[this.idx]].name}`;
      return '';
    }

    begin() {
      this.addStep();
      this.go('intro');
      this.g.setFlicker(false);
    }

    addStep() {
      const s = this.seq;
      let k;
      do { k = Math.floor(Math.random() * 4); } while (s.length >= 2 && s[s.length - 1] === k && s[s.length - 2] === k);
      s.push(k);
      this.hud.label = `Length ${s.length}`;
    }

    go(phase) { this.phase = phase; this.phaseT = 0; }

    get litS() { return Math.max(0.35, 0.62 - 0.025 * this.seq.length); }
    get gapS() { return 0.22; }

    update(gdt) {
      this.phaseT += gdt;
      const g = this.g;
      if (this.phase === 'intro' && this.phaseT >= 0.8) { this.startShow(); return; }
      if (this.phase === 'show') {
        const step = this.litS + this.gapS;
        const i = Math.floor(this.phaseT / step);
        if (i >= this.seq.length) {
          this.lit = -1;
          this.idx = 0;
          this.lastProgress = g.gt;
          this.go('input');
          g.setFlicker(true);
          return;
        }
        const on = this.phaseT - i * step < this.litS;
        const k = on ? this.seq[i] : -1;
        if (k >= 0 && (this.lit !== k || this.shownStep !== i)) { this.shownStep = i; g.sfx.note(COLORS[k].tone); }
        this.lit = k;
        return;
      }
      if (this.phase === 'input' && g.gt - this.lastProgress > TIMEOUT_S) { this.mistake(-1, 'Too slow'); return; }
      if (this.phase === 'between' && this.phaseT >= 0.9) { this.addStep(); this.startShow(); return; }
      if (this.phase === 'oops' && this.phaseT >= 1.1) {
        this.lit = -1;
        if (this.lives <= 0) g.endGame('lives'); else this.startShow();
      }
    }

    startShow() {
      this.g.setFlicker(false);
      this.lit = -1;
      this.shownStep = -1;
      this.go('show');
    }

    isLive() { return this.phase === 'input'; }

    onPick(k) {
      if (this.phase !== 'input') return;
      const g = this.g, r = g.rects[k], want = this.seq[this.idx];
      this.stats.times.push(g.gt - this.lastProgress);
      if (k !== want) { this.mistake(k, 'Oops!'); return; }
      this.stats.correct++;
      g.addScore(1);
      g.ring(k, COLORS[k].rgb);
      g.sfx.note(COLORS[k].tone);
      g.burst(r.cx, r.cy, [COLORS[k].hex, '#ffffff'], 14, { speed: 0.6, stain: false, gravity: 0.3, life: 0.6 });
      this.idx++;
      this.lastProgress = g.gt;
      if (this.idx >= this.seq.length) {
        const n = this.seq.length;
        g.addScore(n);
        this.stats.rounds++;
        this.stats.longest = Math.max(this.stats.longest, n);
        g.text(g.dims.w / 2, g.dims.h * 0.45, `Round ${n} ✓  +${n}`, 'rgba(160,240,160,1)', 1.2, 1.5);
        g.sfx.good();
        g.setFlicker(false);
        this.go('between');
      }
    }

    mistake(k, label) {
      const g = this.g;
      this.stats.wrong++;
      this.lives--;
      this.hud.lives = this.lives;
      if (k >= 0) g.ring(k, '255,90,90');
      g.text(g.dims.w / 2, g.dims.h * 0.45, label, 'rgba(255,130,130,1)', 1.1, 1.5);
      g.sfx.bad();
      g.setFlicker(false);
      this.lit = this.seq[this.idx];   // show which one it should have been
      this.go('oops');
    }

    /* ---------------- drawing ---------------- */
    tileStatic(k) {
      if (this.lit === k) return COLORS[k].hex;
      return this.phase === 'show' || this.phase === 'oops' ? '#3b3b3b' : null;
    }

    hasContent() { return true; }

    drawContent(ctx, k, r) {
      // A coloured disc in the middle, so you can tell the tiles apart while
      // looking straight at one. It flickers with the tile.
      ctx.fillStyle = COLORS[k].hex;
      ctx.beginPath(); ctx.arc(r.cx, r.cy, r.s * 0.17, 0, Math.PI * 2); ctx.fill();
    }

    drawFrame(ctx, k, r) {
      ctx.strokeStyle = COLORS[k].hex;
      ctx.globalAlpha = this.lit === k ? 1 : 0.55;
      ctx.lineWidth = 4;
      ctx.strokeRect(r.x - 3, r.y - 3, r.s + 6, r.s + 6);
      ctx.globalAlpha = 1;
    }

    summaryRows() {
      const s = this.stats, t = s.times.slice().sort((a, b) => a - b), n = s.correct + s.wrong;
      return [
        ['Longest sequence', s.longest], ['Rounds completed', s.rounds],
        ['Correct picks', s.correct], ['Wrong picks', s.wrong],
        ['Pick accuracy', n ? `${Math.round((100 * s.correct) / n)}%` : '—'],
        ['Typical time per pick', t.length ? `${t[t.length >> 1].toFixed(1)} s` : '—'],
      ];
    }
  }

  NP.modes.simon = { cls: SimonMode, name: 'Simon', icon: '🎵', blurb: 'Watch the tiles light up, then repeat the sequence by looking at them. Measures your accuracy.' };
})(window.NP);
