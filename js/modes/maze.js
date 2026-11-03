/* Maze: the four tiles become arrows. Look at one to send the mouse that
   way; it runs along the corridor, round bends, until it reaches a fork, a
   dead end or the cheese, so a long corridor costs one look, not ten.
   Arrows that point into a wall can't be picked. Each maze is bigger than
   the last. 3 minutes. */
(function (NP) {
  'use strict';

  const DURATION = 180;
  const CELL_S = 0.085;          // time to run one cell
  const N = 1, E = 2, S = 4, W = 8;
  // Per tile index: k0 top-left = up, k3 top-right = right, k1 bottom-right = down, k2 bottom-left = left.
  const DIRS = [
    { dx: 0, dy: -1, wall: N, back: S, angle: -Math.PI / 2, name: 'Up' },
    { dx: 0, dy: 1, wall: S, back: N, angle: Math.PI / 2, name: 'Down' },
    { dx: -1, dy: 0, wall: W, back: E, angle: Math.PI, name: 'Left' },
    { dx: 1, dy: 0, wall: E, back: W, angle: 0, name: 'Right' },
  ];
  const SIZES = [[5, 4], [6, 4], [7, 5], [8, 5], [9, 6], [10, 6], [11, 7], [12, 8]];

  /* Perfect maze (one path between any two cells) by depth-first carving. */
  function makeMaze(cols, rows) {
    const walls = Array.from({ length: rows }, () => new Array(cols).fill(N | E | S | W));
    const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
    const stack = [[0, 0]];
    seen[0][0] = true;
    while (stack.length) {
      const [x, y] = stack[stack.length - 1];
      const opts = DIRS.filter((d) => {
        const nx = x + d.dx, ny = y + d.dy;
        return nx >= 0 && ny >= 0 && nx < cols && ny < rows && !seen[ny][nx];
      });
      if (!opts.length) { stack.pop(); continue; }
      const d = opts[Math.floor(Math.random() * opts.length)];
      const nx = x + d.dx, ny = y + d.dy;
      walls[y][x] &= ~d.wall;
      walls[ny][nx] &= ~d.back;
      seen[ny][nx] = true;
      stack.push([nx, ny]);
    }
    // The cheese goes on the cell farthest from the start.
    const dist = Array.from({ length: rows }, () => new Array(cols).fill(-1));
    const q = [[0, 0]];
    dist[0][0] = 0;
    let far = [0, 0];
    while (q.length) {
      const [x, y] = q.shift();
      if (dist[y][x] > dist[far[1]][far[0]]) far = [x, y];
      for (const d of DIRS) {
        if (walls[y][x] & d.wall) continue;
        const nx = x + d.dx, ny = y + d.dy;
        if (dist[ny][nx] < 0) { dist[ny][nx] = dist[y][x] + 1; q.push([nx, ny]); }
      }
    }
    return { cols, rows, walls, goal: far, shortest: dist[far[1]][far[0]] };
  }

  class MazeMode {
    constructor(game) {
      this.g = game;
      this.level = 0;
      this.noCombo = true;
      this.hud = { timer: DURATION, label: 'Maze 1' };
      this.countdownText = 'Look at an arrow to move the mouse';
      this.hint = 'Look at an arrow to send the mouse to the cheese';
      this.stats = { solved: 0, moves: 0, choose: [], mazeTimes: [] };
      this.newMaze();
    }

    newMaze() {
      const [c, r] = SIZES[Math.min(this.level, SIZES.length - 1)];
      this.maze = makeMaze(c, r);
      this.pos = { x: 0, y: 0 };
      this.draw = { x: 0, y: 0 };
      this.run = null;
      this.trail = [{ x: 0, y: 0 }];
      this.trailSeen = new Set(['0,0']);
      this.celebrate = 0;
      this.mazeStart = this.g.gt || 0;
      this.readyAt = this.mazeStart;
      this.hud.label = `Maze ${this.level + 1}`;
      this.image = null;
    }

    open(x, y, d) { return !(this.maze.walls[y][x] & d.wall); }
    openings(x, y) { let n = 0; for (const d of DIRS) if (this.open(x, y, d)) n++; return n; }
    isLive(k) { return !this.run && this.celebrate <= 0 && this.open(this.pos.x, this.pos.y, DIRS[k]); }

    /* Cells the mouse passes through: on along corridors and round bends,
       stopping at a fork, a dead end or the cheese. */
    route(k) {
      const m = this.maze, cells = [];
      let { x, y } = this.pos, d = DIRS[k];
      for (let guard = 0; guard < m.cols * m.rows; guard++) {
        x += d.dx; y += d.dy;
        cells.push({ x, y });
        if (x === m.goal[0] && y === m.goal[1]) break;
        if (this.openings(x, y) !== 2) break;
        const next = DIRS.find((n) => this.open(x, y, n) && n.wall !== d.back);
        if (!next) break;
        d = next;
      }
      return cells;
    }

    onPick(k) {
      if (!this.isLive(k)) return;
      const g = this.g;
      this.stats.moves++;
      this.stats.choose.push(g.gt - this.readyAt);
      this.hint = '';
      g.ring(k, '160,210,255');
      g.sfx.whiff();
      this.run = { cells: this.route(k), i: 0, t: 0, from: { x: this.pos.x, y: this.pos.y } };
    }

    update(gdt) {
      const g = this.g;
      this.hud.timer = DURATION - g.gt;
      if (g.gt >= DURATION) { g.endGame('time'); return; }
      if (this.celebrate > 0) {
        this.celebrate -= gdt;
        if (this.celebrate <= 0) { this.level++; this.newMaze(); this.layout(); }
        return;
      }
      const run = this.run;
      if (!run) return;
      run.t += gdt;
      while (run.t >= CELL_S && run.i < run.cells.length) {
        run.t -= CELL_S;
        run.from = run.cells[run.i];
        this.pos = { x: run.from.x, y: run.from.y };
        const key = `${run.from.x},${run.from.y}`;
        if (!this.trailSeen.has(key)) { this.trailSeen.add(key); this.trail.push(run.from); }
        run.i++;
      }
      if (run.i >= run.cells.length) {
        this.draw.x = this.pos.x; this.draw.y = this.pos.y;
        this.run = null;
        this.readyAt = g.gt;
        const m = this.maze;
        if (this.pos.x === m.goal[0] && this.pos.y === m.goal[1]) this.solved();
        return;
      }
      const to = run.cells[run.i], f = run.t / CELL_S;
      this.draw.x = run.from.x + (to.x - run.from.x) * f;
      this.draw.y = run.from.y + (to.y - run.from.y) * f;
    }

    solved() {
      const g = this.g, pts = 10 + 2 * this.level;
      g.addScore(pts);
      this.stats.solved++;
      this.stats.mazeTimes.push(g.gt - this.mazeStart);
      const p = this.cellCenter(this.maze.goal[0], this.maze.goal[1]);
      g.text(p.x, p.y - this.cs, `Cheese! +${pts}`, 'rgba(255,224,110,1)', 1.3, 1.5);
      g.burst(p.x, p.y, ['#ffd84a', '#fff3b0', '#ffffff'], 24, { speed: 0.8, stain: false, gravity: 0.3, life: 0.8 });
      g.sfx.win();
      this.celebrate = 1.0;
    }

    /* ---------------- drawing ---------------- */
    layout() {
      const g = this.g, box = g.centerBox, m = this.maze;
      if (!box) return;
      this.cs = Math.max(8, Math.floor(Math.min(box.w / m.cols, box.h / m.rows)));
      this.ox = Math.round(box.x + (box.w - this.cs * m.cols) / 2);
      this.oy = Math.round(box.y + (box.h - this.cs * m.rows) / 2);
      this.hintY = g.dims.h - g.dims.m * 0.055;
      this.image = this.paintMaze();
    }

    cellCenter(x, y) { return { x: this.ox + (x + 0.5) * this.cs, y: this.oy + (y + 0.5) * this.cs }; }

    /* Walls are drawn once per maze into a bitmap, not every frame. */
    paintMaze() {
      const g = this.g, m = this.maze, cs = this.cs, dpr = g.dims.dpr;
      const pad = 10, w = cs * m.cols + 2 * pad, h = cs * m.rows + 2 * pad;
      const c = document.createElement('canvas');
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const x = c.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.fillStyle = 'rgba(12,7,3,0.55)';
      x.beginPath(); x.roundRect(0, 0, w, h, 12); x.fill();
      x.strokeStyle = '#f2e2c0';
      x.lineWidth = Math.max(2, cs * 0.09);
      x.lineCap = 'round';
      x.beginPath();
      for (let yy = 0; yy < m.rows; yy++) {
        for (let xx = 0; xx < m.cols; xx++) {
          const wl = m.walls[yy][xx], X = pad + xx * cs, Y = pad + yy * cs;
          if (wl & N) { x.moveTo(X, Y); x.lineTo(X + cs, Y); }
          if (wl & W) { x.moveTo(X, Y); x.lineTo(X, Y + cs); }
          if (yy === m.rows - 1 && (wl & S)) { x.moveTo(X, Y + cs); x.lineTo(X + cs, Y + cs); }
          if (xx === m.cols - 1 && (wl & E)) { x.moveTo(X + cs, Y); x.lineTo(X + cs, Y + cs); }
        }
      }
      x.stroke();
      return { canvas: c, w, h, pad };
    }

    drawWorld(ctx) {
      const g = this.g, img = this.image;
      if (!img) return;
      ctx.drawImage(img.canvas, this.ox - img.pad, this.oy - img.pad, img.w, img.h);
      ctx.fillStyle = 'rgba(255,230,160,0.22)';
      for (const c of this.trail) {
        ctx.beginPath(); ctx.arc(this.ox + (c.x + 0.5) * this.cs, this.oy + (c.y + 0.5) * this.cs, this.cs * 0.09, 0, Math.PI * 2); ctx.fill();
      }
      const z = this.cs * 0.82, cs = this.cs, m = this.maze;
      ctx.drawImage(g.emoji('🧀'), this.ox + (m.goal[0] + 0.5) * cs - z / 2, this.oy + (m.goal[1] + 0.5) * cs - z / 2, z, z);
      ctx.drawImage(g.emoji('🐭'), this.ox + (this.draw.x + 0.5) * cs - z / 2, this.oy + (this.draw.y + 0.5) * cs - z / 2, z, z);
    }

    hasContent() { return true; }

    /* A big arrow on each tile. It flickers with the tile; arrows into a
       wall are drawn faint. */
    drawContent(ctx, k, r) {
      const d = DIRS[k], ok = this.isLive(k) || (this.run && this.open(this.pos.x, this.pos.y, d));
      const L = r.s * 0.26, T = r.s * 0.11;
      ctx.translate(r.cx, r.cy);
      ctx.rotate(d.angle);
      ctx.fillStyle = ok ? '#262626' : '#d9d9d9';
      ctx.beginPath();
      ctx.moveTo(L, 0);
      ctx.lineTo(L * 0.1, -L * 0.8);
      ctx.lineTo(L * 0.1, -T);
      ctx.lineTo(-L, -T);
      ctx.lineTo(-L, T);
      ctx.lineTo(L * 0.1, T);
      ctx.lineTo(L * 0.1, L * 0.8);
      ctx.closePath();
      ctx.fill();
    }

    summaryRows() {
      const s = this.stats, c = s.choose.slice().sort((a, b) => a - b), mt = s.mazeTimes;
      return [
        ['Mazes solved', s.solved], ['Moves', s.moves],
        ['Typical time to choose', c.length ? `${c[c.length >> 1].toFixed(1)} s` : '—'],
        ['Average time per maze', mt.length ? `${(mt.reduce((a, b) => a + b, 0) / mt.length).toFixed(0)} s` : '—'],
      ];
    }
  }

  NP.modes.maze = { cls: MazeMode, name: 'Maze', icon: '🧀', blurb: '3 minutes. Look at the arrows to run the mouse through bigger and bigger mazes to the cheese.' };
})(window.NP);
