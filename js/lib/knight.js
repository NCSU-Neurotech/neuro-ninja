/* NeuroPawn Knight Board: constants, frame parser and Web Serial source.
   Protocol per docs.neuropawn.tech (Data Format, Command Set):
     21-byte frame  [0]=0xA0 [1]=counter [2..17]=8×int16 BE [18]=LOFF P [19]=LOFF N [20]=0xC0
     57-byte frame  same EEG block, [20..55]=9×float32 LE (accel m/s², gyro rad/s, mag µT), [56]=0xC0
   Commands are plain ASCII with no terminator: chon_{ch}_{gain}, choff_{ch},
   rldadd_{ch}, rldremove_{ch}. */
(function (NP) {
  'use strict';

  const KNIGHT = {
    BAUD: 115200,
    START: 0xA0,
    END: 0xC0,
    FRAME_LEN: { knight: 21, imu: 57 },
    N_CH: 8,
    FS: 125,
    GAINS: [1, 2, 3, 4, 6, 8, 12],
    DEFAULT_GAIN: 12,
    HARDWARE_BAND: [1, 62.5],
    /* The vendor's own streamer waits 2 s after each command. */
    CMD_SPACING_MS: 2000,
    /* Wait after opening a port before the first command: boards with an
       auto-reset circuit restart when the port opens. */
    STARTUP_MS: 2000,
    /* µV per count = (4 V / (2^15 − 1)) × (1 / 79.57 AFE gain) × (1 / PGA gain) × 10^6 */
    uvPerCount(gain) { return (4 / 32767) * (1 / 79.57) * (1 / gain) * 1e6; },
    rangeUv(gain) { return 32767 * KNIGHT.uvPerCount(gain); },
    IMU_NAMES: ['Accel X', 'Accel Y', 'Accel Z', 'Gyro X', 'Gyro Y', 'Gyro Z', 'Mag X', 'Mag Y', 'Mag Z'],
    IMU_KEYS: ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z', 'mag_x', 'mag_y', 'mag_z'],
    IMU_UNITS: ['m/s²', 'm/s²', 'm/s²', 'rad/s', 'rad/s', 'rad/s', 'µT', 'µT', 'µT'],
    cmd: {
      on: (ch, gain) => `chon_${ch + 1}_${gain}`,
      off: (ch) => `choff_${ch + 1}`,
      rldOn: (ch) => `rldadd_${ch + 1}`,
      rldOff: (ch) => `rldremove_${ch + 1}`,
    },
  };

  /* Streaming frame parser. Re-synchronises on start/end bytes; while not in
     sync, a candidate frame is accepted only if the next byte is another start
     byte, so a stray 0xA0 inside data can't lock onto the wrong boundary. */
  class KnightParser {
    constructor(boardType) {
      this.buf = new Uint8Array(8192);
      this.dv = new DataView(this.buf.buffer);
      this.len = 0;
      this.frame = { counter: 0, counts: new Int16Array(8), loffP: 0, loffN: 0, imu: new Float32Array(9), hasImu: false };
      this.frames = 0;
      this.syncErrors = 0;
      this.otherLenHits = 0;
      this.synced = false;
      this.setBoardType(boardType || 'knight');
    }
    setBoardType(t) {
      this.boardType = t;
      this.frameLen = KNIGHT.FRAME_LEN[t];
      this.otherLen = t === 'imu' ? KNIGHT.FRAME_LEN.knight : KNIGHT.FRAME_LEN.imu;
      this.otherLenHits = 0;
      // Counted afresh, or minutes of earlier good frames would hold off the
      // "wrong board type" hint for just as long after a mistaken switch.
      this.frames = 0;
      this.synced = false;
    }
    /* True when the byte stream looks like the other board variant. */
    get mismatchSuspected() { return this.otherLenHits > 25 && this.otherLenHits > this.frames; }

    feed(chunk, onFrame) {
      if (this.len + chunk.length > this.buf.length) {
        const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length));
        bigger.set(this.buf.subarray(0, this.len));
        this.buf = bigger;
        this.dv = new DataView(bigger.buffer);
      }
      this.buf.set(chunk, this.len);
      this.len += chunk.length;

      const buf = this.buf, L = this.frameLen, O = this.otherLen;
      let i = 0;
      while (i + L <= this.len) {
        if (buf[i] !== KNIGHT.START) {
          if (this.synced) { this.syncErrors++; this.synced = false; }
          i++;
          continue;
        }
        if (buf[i + L - 1] !== KNIGHT.END) {
          if (i + O < this.len && buf[i + O - 1] === KNIGHT.END && buf[i + O] === KNIGHT.START) this.otherLenHits++;
          if (this.synced) { this.syncErrors++; this.synced = false; }
          i++;
          continue;
        }
        if (!this.synced) {
          if (i + L >= this.len) break;              // wait for the next byte to confirm
          if (buf[i + L] !== KNIGHT.START) { i++; continue; }
        }
        this.decode(i, onFrame);
        this.synced = true;
        this.frames++;
        i += L;
      }
      if (i > 0) {
        buf.copyWithin(0, i, this.len);
        this.len -= i;
      }
    }

    decode(i, onFrame) {
      const f = this.frame, b = this.buf, dv = this.dv;
      f.counter = b[i + 1];
      for (let c = 0; c < 8; c++) f.counts[c] = dv.getInt16(i + 2 + 2 * c, false);
      f.loffP = b[i + 18];
      f.loffN = b[i + 19];
      if (this.frameLen === KNIGHT.FRAME_LEN.imu) {
        for (let k = 0; k < 9; k++) f.imu[k] = dv.getFloat32(i + 20 + 4 * k, true);
        f.hasImu = true;
      } else {
        f.hasImu = false;
      }
      onFrame(f);
    }

    reset() { this.len = 0; this.synced = false; this.frames = 0; this.syncErrors = 0; this.otherLenHits = 0; }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Command queue shared by both sources. Pending commands with the same key
     are replaced, so rapid toggling ends in the final state without waiting
     for every intermediate command. */
  class CommandQueue {
    constructor(write, spacingMs, onProgress) {
      this.write = write;
      this.spacingMs = spacingMs;
      this.onProgress = onProgress || (() => {});
      this.items = [];
      this.running = false;
      this.cancelled = false;
      this.sent = 0;
      this.holdUntil = 0;
    }
    /* Delay the next command by at least ms. */
    hold(ms) {
      this.holdUntil = Math.max(this.holdUntil, performance.now() + ms);
    }
    push(key, cmd) {
      const existing = this.items.find((it) => it.key === key);
      if (existing) existing.cmd = cmd; else this.items.push({ key, cmd });
      this.onProgress(this.items.length, null);
      if (!this.running) this.run();
    }
    get pending() { return this.items.length; }
    async run() {
      this.running = true;
      while (this.items.length && !this.cancelled) {
        const wait = this.holdUntil - performance.now();
        if (wait > 0) { await sleep(wait); continue; }
        const it = this.items.shift();
        try {
          await this.write(it.cmd);
          this.sent++;
          this.onProgress(this.items.length, it.cmd);
        } catch (err) {
          this.onProgress(this.items.length, null, err);
        }
        // After every write — not only when more are queued. A command pushed
        // into an idle queue half a second later must still wait: with no
        // terminator, two commands arriving back to back can merge on the
        // board while the app records both as sent.
        if (this.spacingMs > 0) this.hold(this.spacingMs);
      }
      this.running = false;
      this.onProgress(0, null);
    }
    cancel() { this.cancelled = true; this.items.length = 0; }
  }

  class KnightSerialSource {
    /* opts: {boardType, onFrame, onError, onClosed, onCommandProgress} */
    constructor(opts) {
      this.kind = 'serial';
      this.opts = opts;
      this.parser = new KnightParser(opts.boardType);
      this.port = null;
      this.reader = null;
      this.keepReading = false;
      this.enc = new TextEncoder();
      this.queue = new CommandQueue((cmd) => this.writeRaw(cmd), KNIGHT.CMD_SPACING_MS, opts.onCommandProgress);
      this.fs = KNIGHT.FS;
      this.onDisconnectEvent = (e) => { if (e.target === this.port) this.handleLost(new Error('Device disconnected')); };
    }
    static get supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }

    /* Must be called from a user gesture (the browser shows its port picker). */
    async start() {
      this.port = this.opts.port || await navigator.serial.requestPort();
      await this.port.open({ baudRate: KNIGHT.BAUD, bufferSize: 1 << 16 });
      this.queue.hold(KNIGHT.STARTUP_MS);
      navigator.serial.addEventListener('disconnect', this.onDisconnectEvent);
      this.keepReading = true;
      this.loop = this.readLoop();
      const info = this.port.getInfo ? this.port.getInfo() : {};
      return info;
    }

    async readLoop() {
      const onFrame = this.opts.onFrame;
      while (this.port && this.port.readable && this.keepReading) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && value.length) this.parser.feed(value, onFrame);
          }
        } catch (err) {
          // Framing/overrun errors are recoverable: the loop reacquires a reader.
          if (this.keepReading && this.opts.onError) this.opts.onError(err);
        } finally {
          try { this.reader.releaseLock(); } catch (e) { /* already released */ }
          this.reader = null;
        }
      }
    }

    async writeRaw(cmd) {
      if (!this.port || !this.port.writable) throw new Error('Port not writable');
      const writer = this.port.writable.getWriter();
      try { await writer.write(this.enc.encode(cmd)); }
      finally { writer.releaseLock(); }
    }

    send(key, cmd) { this.queue.push(key, cmd); }

    setBoardType(t) { this.parser.setBoardType(t); }

    handleLost(err) {
      if (!this.keepReading) return;
      this.stop().finally(() => this.opts.onClosed && this.opts.onClosed(err));
    }

    async stop() {
      this.keepReading = false;
      this.queue.cancel();
      navigator.serial && navigator.serial.removeEventListener('disconnect', this.onDisconnectEvent);
      try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
      try { if (this.loop) await this.loop; } catch (e) { /* ignore */ }
      try { if (this.port) await this.port.close(); } catch (e) { /* ignore */ }
      this.port = null;
    }
  }

  /* Same interface as KnightSerialSource, but the port is opened by serve.ps1
     and bytes travel over a local WebSocket. opts.path is the COM port name. */
  class KnightBridgeSource {
    constructor(opts) {
      this.kind = 'serial';
      this.opts = opts;
      this.parser = new KnightParser(opts.boardType);
      this.queue = new CommandQueue((cmd) => this.writeRaw(cmd), KNIGHT.CMD_SPACING_MS, opts.onCommandProgress);
      this.fs = KNIGHT.FS;
      this.ws = null;
      this.closing = false;
      this.lostError = null;
    }

    start() {
      return new Promise((resolve, reject) => {
        const url = new URL(`api/serial?port=${encodeURIComponent(this.opts.path)}&baud=${KNIGHT.BAUD}`, location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        let ws;
        try { ws = new WebSocket(url.href); } catch (err) { reject(err); return; }
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        let opened = false;
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') {
            if (opened) this.parser.feed(new Uint8Array(ev.data), this.opts.onFrame);
            return;
          }
          let msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (msg.type === 'opened') {
            opened = true;
            this.queue.hold(KNIGHT.STARTUP_MS);
            resolve({ port: msg.port });
          } else if (msg.type === 'error') {
            const err = new Error(msg.message);
            if (opened) this.lostError = err; else { this.closing = true; reject(err); }
          }
        };
        ws.onerror = () => {
          if (!opened) { this.closing = true; reject(new Error('Could not reach serve.ps1. Is its window still open?')); }
        };
        ws.onclose = () => {
          if (!opened) { reject(new Error('serve.ps1 closed the connection.')); return; }
          if (this.closing) return;
          this.closing = true;
          this.queue.cancel();
          if (this.opts.onClosed) this.opts.onClosed(this.lostError || new Error('serve.ps1 stopped'));
        };
      });
    }

    writeRaw(cmd) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Port not open'));
      this.ws.send(cmd);
      return Promise.resolve();
    }

    send(key, cmd) { this.queue.push(key, cmd); }

    setBoardType(t) { this.parser.setBoardType(t); }

    async stop() {
      this.closing = true;
      this.queue.cancel();
      if (this.ws) { try { this.ws.close(); } catch (e) { /* already closed */ } }
      this.ws = null;
    }
  }

  NP.KNIGHT = KNIGHT;
  NP.KnightParser = KnightParser;
  NP.KnightBridgeSource = KnightBridgeSource;
  NP.CommandQueue = CommandQueue;
  NP.KnightSerialSource = KnightSerialSource;
})(window.NP);
