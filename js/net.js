// Real-time link to a room: the same system as the Dakheel game. Reconnects on its own (the saved token keeps
// your seat), notices a link that died while the phone slept, and keeps the server clock for the timers.

// The rooms run on the Dakheel server (Cloudflare). ?server=ws://127.0.0.1:8787 points a test page elsewhere.
const SERVER = new URLSearchParams(location.search).get("server") || "wss://al-dakheel.vamosx.workers.dev";

export const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LEN = 5;
export const normalizeCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);
export const isValidCode = (c) => c.length === CODE_LEN && [...c].every((x) => CODE_CHARS.includes(x));
export const randomCode = () => Array.from({ length: CODE_LEN }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

export class Net {
  constructor({ code, create, onMessage, onStatus }) {
    Object.assign(this, { code, create, onMessage, onStatus });
    this.ws = null;
    this.tries = 0;
    this.closed = false;
    this.offset = 0;
    this.bestRtt = Infinity;
  }

  url() { return `${SERVER}/mafia/ws/${this.code}${this.create ? "?create=1" : ""}`; }

  connect(hello) { this.hello = hello; this.open(); }

  open() {
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.create = false; // reconnects join the room that now exists
      this.lastMsgAt = Date.now();
      this.onStatus?.("open");
      this.send({ t: "hello", ...this.hello() });
      this.ping();
      clearInterval(this.pinger);
      this.pinger = setInterval(() => { this.ping(); this.checkAlive(); }, 4000);
    };
    ws.onmessage = (e) => {
      this.lastMsgAt = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === "pong") return this.pong(msg);
      if (msg.t === "error") this.closed = true;
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      clearInterval(this.pinger);
      if (this.closed) return;
      this.onStatus?.("lost");
      const delay = Math.min(5000, 400 * 2 ** this.tries++);
      this.retry = setTimeout(() => !this.closed && this.open(), delay);
    };
  }

  /** The server answers pings, so a long silence means the link is gone even if Safari says "open". */
  checkAlive() {
    if (this.closed || !this.ws || this.ws.readyState !== 1) return;
    if (Date.now() - (this.lastMsgAt || 0) > 12000) try { this.ws.close(); } catch { /* reconnects */ }
  }

  wake() {
    if (this.closed) return;
    if (!this.ws || this.ws.readyState > 1) { clearTimeout(this.retry); this.open(); return; }
    this.ping();
    setTimeout(() => this.checkAlive(), 3000);
  }

  send(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  ping() { this.send({ t: "ping", c: performance.now() }); }

  pong(msg) {
    const rtt = performance.now() - msg.c;
    if (rtt <= this.bestRtt * 1.2) { this.bestRtt = Math.min(this.bestRtt, rtt); this.offset = msg.now + rtt / 2 - Date.now(); }
  }

  serverNow() { return Date.now() + this.offset; }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    clearTimeout(this.retry);
    try { this.ws?.close(); } catch { /* gone */ }
  }
}
