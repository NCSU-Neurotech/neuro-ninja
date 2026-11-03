/* Menu, settings, fullscreen, pause and results. */
(function (NP) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const K = NP.KNIGHT;
  const STORE = 'neuro-ninja-settings', BEST = 'neuro-ninja-best';
  // Saved under these names while the game was called Mind Ninja.
  const OLD_KEYS = { [STORE]: 'mind-ninja-settings', [BEST]: 'mind-ninja-best' };

  function load(key) {
    try {
      let s = localStorage.getItem(key);
      if (s == null && OLD_KEYS[key]) s = localStorage.getItem(OLD_KEYS[key]);
      const v = JSON.parse(s);
      return v && typeof v === 'object' ? v : {};
    } catch (e) { return {}; }
  }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

  // Games in the list; the accuracy test and calibration are hidden modes
  // started from their own buttons.
  const GAMES = Object.keys(NP.modes).filter((k) => !NP.modes[k].hidden);

  // Every stored value is checked before use.
  const raw = load(STORE);
  const S = {
    source: pick(raw.source, ['serial', 'sim'], 'serial'),
    boardType: pick(raw.boardType, ['knight', 'imu'], 'knight'),
    gain: pick(raw.gain, K.GAINS, 4),
    rld: typeof raw.rld === 'boolean' ? raw.rld : true,
    mains: pick(raw.mains, [50, 60], 60),
    chans: Array.isArray(raw.chans) && raw.chans.length && raw.chans.every((c) => Number.isInteger(c) && c >= 0 && c < 8)
      ? [...new Set(raw.chans)].sort() : [4, 5, 6, 7],
    windowS: pick(raw.windowS, [1.5, 2, 3], 2),
    rates: pick(raw.rates, ['alphafree', 'visualizer'], 'alphafree'),
    mode: pick(raw.mode, GAMES, 'classic'),
    muted: !!raw.muted,
    useCalib: typeof raw.useCalib === 'boolean' ? raw.useCalib : true,
    testBlocks: pick(raw.testBlocks, [3, 5], 3),
  };
  const rawBest = load(BEST);
  const best = {};
  for (const key of GAMES) best[key] = Math.max(0, rawBest[key] | 0);
  const persist = () => save(STORE, S);

  const eeg = new NP.EegEngine();
  const sfx = new NP.Sfx();
  sfx.muted = S.muted;
  const game = new NP.Game($('game'), eeg, sfx);
  const ports = new NP.PortManager(renderPorts);
  eeg.setConfig({ chans: S.chans, gain: S.gain, rld: S.rld, boardType: S.boardType });

  /* ---------------- menu controls ---------------- */
  $('selSource').value = S.source;
  $('selBoard').value = S.boardType;
  $('selGain').value = String(S.gain);
  $('selMains').value = String(S.mains);
  $('chkRld').checked = S.rld;
  $('selWindow').value = String(S.windowS);
  $('selRates').value = S.rates;
  $('chkUseCalib').checked = S.useCalib;
  $('selTestLen').value = String(S.testBlocks);

  $('selSource').addEventListener('change', (e) => { S.source = e.target.value; persist(); syncUi(); });
  $('selBoard').addEventListener('change', (e) => { S.boardType = e.target.value; persist(); eeg.setConfig({ boardType: S.boardType }); });
  $('selGain').addEventListener('change', (e) => { S.gain = +e.target.value; persist(); eeg.setConfig({ gain: S.gain }); });
  $('selMains').addEventListener('change', (e) => { S.mains = +e.target.value; persist(); syncUi(); });
  $('chkRld').addEventListener('change', (e) => { S.rld = e.target.checked; persist(); eeg.setConfig({ rld: S.rld }); });
  $('selWindow').addEventListener('change', (e) => { S.windowS = +e.target.value; persist(); syncUi(); });
  $('selRates').addEventListener('change', (e) => { S.rates = e.target.value; persist(); syncUi(); });
  $('chkUseCalib').addEventListener('change', (e) => { S.useCalib = e.target.checked; persist(); syncUi(); });
  $('selTestLen').addEventListener('change', (e) => { S.testBlocks = +e.target.value; persist(); syncUi(); });
  $('btnRefresh').addEventListener('click', () => ports.refresh());
  $('btnConnect').addEventListener('click', async () => {
    if (!eeg.connected) { connect(); return; }
    await eeg.disconnect();
    ports.setPaused(false);
    status('connStatus', 'Disconnected');
    syncUi();
  });

  const chanBox = $('chans');
  for (let c = 0; c < 8; c++) {
    const lab = document.createElement('label');
    lab.className = 'chan';
    lab.innerHTML = `<input type="checkbox" autocomplete="off" value="${c}"><span class="n">${c + 1}</span><span class="q"></span>`;
    chanBox.append(lab);
  }
  chanBox.addEventListener('change', () => {
    const chosen = [...chanBox.querySelectorAll('input:checked')].map((i) => +i.value);
    if (!chosen.length) { syncChans(); return; }   // at least one channel stays ticked
    setChans(chosen);
  });
  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    setChans(b.dataset.preset === 'all' ? [0, 1, 2, 3, 4, 5, 6, 7] : [4, 5, 6, 7]);
  }));
  function setChans(list) {
    S.chans = list;
    persist();
    eeg.setConfig({ chans: S.chans });
    syncChans();
  }

  // One row per registered game (js/modes/*.js), with its best score.
  const modeList = $('modeList');
  for (const key of GAMES) {
    const m = NP.modes[key];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mode';
    b.setAttribute('role', 'radio');
    b.dataset.mode = key;
    const parts = [['mi', m.icon], ['mn', m.name], ['ms', ''], ['mb', m.blurb]];
    for (const [cls, text] of parts) {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      b.append(s);
    }
    modeList.append(b);
  }
  modeList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    S.mode = b.dataset.mode;
    persist();
    syncMode();
  });
  modeList.addEventListener('keydown', (e) => {
    // Arrow keys move between games, as in any radio group.
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const keys = GAMES, step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    S.mode = keys[(keys.indexOf(S.mode) + step + keys.length) % keys.length];
    persist();
    syncMode();
    modeList.querySelector(`[data-mode="${S.mode}"]`).focus();
  });
  function syncMode() {
    modeList.querySelectorAll('.mode').forEach((b) => {
      const on = b.dataset.mode === S.mode;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      const ms = b.querySelector('.ms');
      const n = best[b.dataset.mode];
      ms.replaceChildren();
      if (n > 0) { ms.append('Best '); const v = document.createElement('b'); v.textContent = String(n); ms.append(v); }
    });
  }

  function renderPorts() {
    const sel = $('selPort');
    const prev = sel.value;
    sel.replaceChildren();
    if (ports.mode === 'detecting') {
      sel.append(new Option('Looking for ports…', ''));
    } else if (ports.mode === 'none') {
      sel.append(new Option('No port access in this browser', ''));
    } else {
      if (!ports.ports.length) sel.append(new Option(ports.mode === 'bridge' ? 'No COM ports found: plug in the board' : 'No ports allowed yet', ''));
      for (const p of ports.ports) sel.append(new Option(p.label, p.id));
      if (ports.mode === 'webserial') sel.append(new Option('Find a port…', 'request'));
      const want = ports.find(prev) ? prev : ports.suggested();
      if (want) sel.value = want;
      else if (ports.mode === 'webserial') sel.value = 'request';
    }
    syncUi();
  }

  /* ---------------- connection ---------------- */
  function status(el, text, tone) { const n = $(el); n.textContent = text; if (tone) n.dataset.tone = tone; else delete n.dataset.tone; }

  async function connect() {
    const kind = S.source;
    const opts = { kind };
    if (kind === 'serial') {
      if (ports.mode === 'bridge') {
        const p = ports.find($('selPort').value);
        if (!p) { status('connStatus', "Choose the board's COM port first. Not sure which? Unplug it and see which one disappears.", 'bad'); return; }
        opts.path = p.path;
        ports.remember(p.id);
      } else if (ports.mode === 'webserial') {
        const p = ports.find($('selPort').value);
        opts.port = p ? p.serialPort : null;   // null: the browser shows its port picker
        if (p) ports.remember(p.id);
      } else {
        status('connStatus', "This browser can't reach USB ports. Start the game with Start Neuro Ninja.cmd, or open it in Chrome or Edge.", 'bad');
        return;
      }
    }
    eeg.setConfig({ chans: S.chans, gain: S.gain, rld: S.rld, boardType: S.boardType });
    status('connStatus', kind === 'sim' ? 'Starting the simulator…' : 'Opening the port…');
    syncUi();
    try {
      await eeg.connect(opts);
      if (kind === 'serial') ports.setPaused(true);
    } catch (err) {
      status('connStatus', err && err.name === 'NotFoundError' ? 'No port chosen.' : `Could not connect: ${err && err.message ? err.message : err}`, 'bad');
      if (ports.mode !== 'none') ports.refresh();
    }
    syncUi();
  }

  eeg.onChange = () => syncUi();
  eeg.onClosed = (err) => {
    ports.setPaused(false);
    status('connStatus', `Disconnected: ${err && err.message ? err.message : 'the board stopped'}`, 'bad');
    if (inGame()) pauseGame('The board disconnected. Reconnect from the menu.');
  };

  const QUALITY_TONE = { ok: 'ok', warn: 'warn', railed: 'bad', flat: 'bad', nodata: 'bad' };
  function syncChans() {
    const q = eeg.updateQuality(true);
    chanBox.querySelectorAll('.chan').forEach((lab, c) => {
      const on = S.chans.includes(c);
      lab.querySelector('input').checked = on;
      const info = on && eeg.connected ? q[c] : null;
      lab.querySelector('.q').textContent = on ? (info ? info.text : 'Back of head') : '';
      if (info) lab.dataset.q = QUALITY_TONE[info.state]; else delete lab.dataset.q;
    });
  }

  function syncUi() {
    const serial = S.source === 'serial';
    $('portRow').hidden = !serial;
    $('btnConnect').textContent = eeg.connected ? 'Disconnect' : 'Connect';
    $('btnConnect').disabled = eeg.busy;
    for (const id of ['selSource', 'selPort', 'btnRefresh', 'selBoard']) $(id).disabled = eeg.connected || eeg.busy;
    if (eeg.connected) {
      if (eeg.configuring) {
        const n = eeg.pending;
        const secs = eeg.kind === 'serial' ? ` (about ${Math.max(1, Math.ceil((n * K.CMD_SPACING_MS) / 1000))} s)` : '';
        status('connStatus', `Setting up the board: ${n} command${n === 1 ? '' : 's'} to go${secs}`);
      } else if (eeg.commandError) {
        status('connStatus', `A board command failed: ${eeg.commandError}`, 'bad');
      } else {
        status('connStatus', eeg.kind === 'sim' ? 'Simulator running' : `Connected${eeg.dropped ? ` · ${eeg.dropped} packets dropped` : ''}`, 'good');
      }
    }
    syncChans();
    const usable = eeg.connected ? eeg.usableChans : [];
    let why = '';
    if (!eeg.connected) why = 'Connect first.';
    else if (eeg.configuring) why = 'Waiting for the board setup to finish…';
    else if (!usable.length) why = 'None of the ticked channels has a usable signal yet.';
    $('btnPlay').disabled = !!why;
    $('btnCalib').disabled = !!why;
    $('btnTest').disabled = !!why;
    if (why) status('playStatus', why);
    else {
      const dropped = S.chans.filter((c) => !usable.includes(c));
      status('playStatus', dropped.length ? `Channel${dropped.length > 1 ? 's' : ''} ${dropped.map((c) => c + 1).join(', ')} will be left out (no clean signal).` : `Ready: ${usable.length} channel${usable.length > 1 ? 's' : ''} on the back of the head.`, dropped.length ? null : 'good');
    }
    syncChecks(usable);
  }

  /* ---------------- calibration and accuracy test ---------------- */
  const RATE_LABEL = { alphafree: '12–15 Hz', visualizer: '7.5–12 Hz' };
  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(+d) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  };

  /* The calibration that applies to the current settings and channels. */
  function currentCalib(chans) {
    return NP.calib.find({ rates: S.rates, windowS: S.windowS, lineFreq: S.mains, chans });
  }

  function syncChecks(usable) {
    $('checkFor').textContent = `For the settings in Play: ${RATE_LABEL[S.rates]} flicker, ${S.windowS} s decision window. Each combination keeps its own calibration.`;
    const c = currentCalib(eeg.connected && usable.length ? usable : null);
    if (c.entry) {
      const e = c.entry;
      const targets = NP.GAME_RATE_SETS[S.rates].map((f) => ({ f }));
      const weak = NP.calib.weakTiles(e, targets);
      status('calibStatus', `Calibrated ${when(e.at)}: ${Math.round(e.acc * e.n)} of ${e.n} looks right.${weak ? ` Weak tile: ${weak}` : ''}${S.useCalib ? '' : ' Turned off below.'}`, weak ? null : S.useCalib ? 'good' : null);
    } else if (c.why === 'chans') {
      status('calibStatus', `Calibrated with channel${c.saved.chans.length > 1 ? 's' : ''} ${c.saved.chans.map((x) => x + 1).join(', ')}, but the usable channels are different now. Calibrate again.`, 'bad');
    } else if (c.why === 'mains') {
      status('calibStatus', `Calibrated for ${c.saved.lineFreq} Hz mains. Calibrate again for ${S.mains} Hz.`, 'bad');
    } else {
      status('calibStatus', 'Not calibrated for these settings yet.');
    }
    $('testDur').textContent = S.testBlocks === 5 ? 'about 1½ minutes' : 'about 1 minute';
    const t = NP.calib.lastTest();
    if (t) {
      status('testStatus', `Last test ${when(t.at)}: ${Math.round(100 * t.acc)}% (${t.correct} of ${t.n}), ${RATE_LABEL[t.rates] || t.rates}${t.calibrated ? ', calibrated' : ''}.`, t.acc >= 0.7 ? 'good' : t.acc < 0.4 ? 'bad' : null);
    } else {
      status('testStatus', 'No test yet.');
    }
  }
  setInterval(() => { if (!$('menu').hidden) syncUi(); }, 500);

  /* ---------------- playing ---------------- */
  const stage = $('stage');
  let fsWanted = false, wasFs = false;
  const inGame = () => ['countdown', 'playing'].includes(game.state);
  const isFs = () => document.fullscreenElement === stage;

  // What the epilepsy warning's "start" button will start. Everything that
  // flickers goes through the warning, every time.
  let pending = null, lastRun = null;
  const ask = (run) => { pending = run; $('warn').showModal(); };
  $('btnPlay').addEventListener('click', () => ask({ mode: S.mode }));
  $('btnCalib').addEventListener('click', () => ask({ mode: 'calib' }));
  $('btnTest').addEventListener('click', () => ask({ mode: 'acc', blocks: S.testBlocks }));
  $('warnCancel').addEventListener('click', () => $('warn').close());
  $('warnOk').addEventListener('click', () => { $('warn').close(); if (pending) startGame(pending); });

  function enterFullscreen() {
    if (!stage.requestFullscreen || isFs()) return;
    fsWanted = true;
    // Must run inside the click; the 3 s countdown covers the transition.
    stage.requestFullscreen().catch(() => { fsWanted = false; });
  }

  function startGame(run) {
    run = run || { mode: S.mode };
    lastRun = run;
    sfx.ensure();
    $('menu').hidden = true;
    stage.hidden = false;
    $('pauseOverlay').hidden = true;
    $('overOverlay').hidden = true;
    stage.classList.toggle('no-cursor', eeg.kind !== 'sim');
    enterFullscreen();
    // Calibration itself always starts from raw scores.
    const calib = run.mode !== 'calib' && S.useCalib ? currentCalib(eeg.usableChans).entry : null;
    game.start({
      mode: run.mode, blocks: run.blocks, rates: S.rates, windowS: S.windowS, lineFreq: S.mains,
      sim: eeg.kind === 'sim', best: best[run.mode] || 0, calib,
    });
  }

  game.onFlickerStart = () => { if (eeg.kind === 'sim') eeg.setSimGaze(game.hover); };

  function pauseGame(reason) {
    if (!game.pause()) return;
    $('pauseReason').textContent = reason || '';
    $('pauseOverlay').hidden = false;
    stage.classList.remove('no-cursor');
  }

  $('btnResume').addEventListener('click', () => {
    if (!eeg.connected) { quitToMenu(); return; }
    $('pauseOverlay').hidden = true;
    stage.classList.toggle('no-cursor', eeg.kind !== 'sim');
    enterFullscreen();
    game.resume();
  });
  $('btnQuit').addEventListener('click', quitToMenu);
  $('btnMenu').addEventListener('click', quitToMenu);
  $('btnAgain').addEventListener('click', () => {
    if (!eeg.connected) { quitToMenu(); return; }
    ask(lastRun || { mode: S.mode });
  });

  function quitToMenu() {
    game.stop();
    if (isFs()) document.exitFullscreen().catch(() => {});
    stage.hidden = true;
    $('menu').hidden = false;
    syncUi();
  }

  game.onOver = (r) => {
    stage.classList.remove('no-cursor');
    if (isFs()) document.exitFullscreen().catch(() => {});
    if (r.result) {
      // Accuracy test or calibration: their own heading, no best score.
      $('overTitle').textContent = r.result.title;
      $('overScore').textContent = r.result.big;
      $('overBest').textContent = r.result.sub;
      $('btnAgain').textContent = r.mode === 'calib' ? 'Calibrate again' : 'Test again';
    } else {
      const newBest = r.score > best[r.mode];
      if (newBest) { best[r.mode] = r.score; save(BEST, best); }
      $('overTitle').textContent = r.reason === 'time' ? "Time's up!" : r.reason === 'done' ? 'Well done!' : 'Game over';
      $('overScore').textContent = String(r.score);
      $('overBest').textContent = newBest && r.score > 0 ? 'New best!' : `Best: ${best[r.mode]}`;
      $('btnAgain').textContent = 'Play again';
    }
    syncMode();
    $('overStats').replaceChildren(...r.rows.map(([k, v]) => {
      const d = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = String(v);
      d.append(dt, dd);
      return d;
    }));
    $('overOverlay').hidden = false;
  };

  document.addEventListener('fullscreenchange', () => {
    const now = isFs();
    // Esc in fullscreen is kept by the browser: it leaves fullscreen and the
    // page never sees the key. Leaving fullscreen therefore pauses.
    if (wasFs && !now && inGame()) pauseGame('You left fullscreen.');
    wasFs = now;
    if (!now) fsWanted = false;
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && inGame()) pauseGame('The game was hidden.'); });
  document.addEventListener('keydown', (e) => {
    if (stage.hidden || $('warn').open) return;
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'p' || e.key === 'P') {
      if (inGame()) { e.preventDefault(); pauseGame('Paused.'); }
      else if (game.state === 'paused' && e.key !== 'Escape') { e.preventDefault(); $('btnResume').click(); }
    } else if (e.key === 'm' || e.key === 'M') {
      S.muted = !S.muted; sfx.muted = S.muted; persist();
    }
  });

  // Simulator: the tile under the mouse pointer is the one being "looked at".
  stage.addEventListener('mousemove', (e) => {
    if (eeg.kind !== 'sim') return;
    const r = stage.getBoundingClientRect();
    const k = game.tileAt(e.clientX - r.left, e.clientY - r.top);
    game.hover = k;
    if (game.flickering) eeg.setSimGaze(k);
  });
  stage.addEventListener('mouseleave', () => { game.hover = -1; eeg.setSimGaze(-1); });

  syncMode();
  syncUi();
  ports.detect();

  NP.main = { eeg, game, sfx, S, startGame, pauseGame, quitToMenu };
})(window.NP);
