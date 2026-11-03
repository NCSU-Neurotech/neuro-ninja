/* Port list for the Connection card.
   - "bridge":    the page is served by serve.ps1, which lists every COM port
                  with its Windows name and relays the chosen one over a local
                  WebSocket. Works in any browser.
   - "webserial": Chrome/Edge Web Serial. Browsers only reveal ports the user
                  has allowed, so the list holds those plus "Find a port…".
   - "none":      neither is available. */
(function (NP) {
  'use strict';

  const VENDORS = { '0403': 'FTDI', '1A86': 'CH340', '10C4': 'Silicon Labs', '2341': 'Arduino', '303A': 'Espressif', '239A': 'Adafruit', '0483': 'STMicro' };
  const STORE_KEY = 'np-port';
  const POLL_MS = 3000;
  const hex4 = (n) => (n == null ? '' : n.toString(16).toUpperCase().padStart(4, '0'));

  class PortManager {
    constructor(onChange) {
      this.mode = 'detecting';
      this.ports = [];
      this.error = '';
      this.onChange = onChange || (() => {});
      this.sig = null;
      this.paused = false;
      this.busy = false;
      try { this.remembered = localStorage.getItem(STORE_KEY) || ''; } catch (e) { this.remembered = ''; }
    }

    async detect() {
      this.onChange();
      const list = /^https?:$/.test(location.protocol) ? await this.fetchBridge() : null;
      if (list) {
        this.mode = 'bridge';
        this.setList(list);
        setInterval(() => { if (!this.paused && !document.hidden) this.refresh(); }, POLL_MS);
        window.addEventListener('focus', () => { if (!this.paused) this.refresh(); });
        return;
      }
      if ('serial' in navigator) {
        this.mode = 'webserial';
        navigator.serial.addEventListener('connect', () => this.refresh());
        navigator.serial.addEventListener('disconnect', () => this.refresh());
        await this.refresh();
        return;
      }
      this.mode = 'none';
      this.setList([]);
    }

    /* Returns the port list from serve.ps1, or null if it isn't there. */
    async fetchBridge() {
      try {
        const res = await fetch('api/ports', { cache: 'no-store' });
        if (!res.ok) return null;
        const j = await res.json();
        if (!j || j.ok !== true || !Array.isArray(j.ports)) return null;
        return j.ports.map((p) => {
          const vid = String(p.vid || '').toUpperCase();
          const vendor = VENDORS[vid];
          const name = String(p.name || '').replace(/\s*\(COM\d+\)\s*$/i, '').trim() || 'Serial port';
          const parts = [p.path, name];
          if (vendor && !name.toUpperCase().includes(vendor.toUpperCase())) parts.push(vendor);
          return { id: 'com:' + p.path, path: p.path, short: p.path, label: parts.join(' · ') + (p.inUse ? ' (open)' : ''), usb: !!vid };
        });
      } catch (e) {
        return null;
      }
    }

    async refresh() {
      if (this.busy) return;
      this.busy = true;
      try {
        if (this.mode === 'bridge') {
          const list = await this.fetchBridge();
          this.error = list ? '' : 'Lost contact with serve.ps1. Is its window still open?';
          this.setList(list || []);
        } else if (this.mode === 'webserial') {
          let granted = [];
          try { granted = await navigator.serial.getPorts(); } catch (e) { /* blocked by policy */ }
          const seen = {};
          this.setList(granted.map((port) => {
            const info = port.getInfo ? port.getInfo() : {};
            const vid = hex4(info.usbVendorId), pid = hex4(info.usbProductId);
            const key = vid ? `${vid}-${pid}` : 'serial';
            const n = (seen[key] = (seen[key] || 0) + 1);
            const vendor = VENDORS[vid];
            const base = vid ? `USB serial ${vid}:${pid}${vendor ? ' · ' + vendor : ''}` : 'Serial port';
            return { id: `ws:${key}:${n}`, serialPort: port, short: vendor ? `${vendor} USB serial` : 'USB serial', label: n > 1 ? `${base} (${n})` : base, usb: !!vid };
          }));
        }
      } finally {
        this.busy = false;
      }
    }

    setList(list) {
      this.ports = list;
      const sig = `${this.mode}|${this.error}|${list.map((p) => p.id + '=' + p.label).join('|')}`;
      if (sig !== this.sig) { this.sig = sig; this.onChange(); }
    }

    find(id) { return this.ports.find((p) => p.id === id) || null; }

    /* Last port used, else the first USB port (skips built-in COM1-style ports), else the first. */
    suggested() {
      if (!this.ports.length) return '';
      const known = this.find(this.remembered);
      if (known) return known.id;
      return (this.ports.find((p) => p.usb) || this.ports[0]).id;
    }

    remember(id) {
      if (!id || id === 'request') return;
      this.remembered = id;
      try { localStorage.setItem(STORE_KEY, id); } catch (e) { /* storage unavailable */ }
    }

    setPaused(paused) {
      const resume = this.paused && !paused;
      this.paused = paused;
      if (resume) this.refresh();
    }
  }

  NP.PortManager = PortManager;
})(window.NP);
