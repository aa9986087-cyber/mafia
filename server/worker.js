// The Mafia game's own server on Cloudflare Workers (free plan). Each room is one Durable Object holding the
// live WebSockets; the pages themselves are on GitHub Pages. Nothing here is shared with the other games.
import { DurableObject } from "cloudflare:workers";
import { MafiaRoom, MAFIA_TICK_MS } from "./room.js";

import { CODE_CHARS } from "./codes.js";
const normalizeCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
const isValidCode = (c) => c.length === 5 && [...c].every((x) => CODE_CHARS.includes(x));

// Only the game's pages (and local testing) may open a room.
const ORIGINS = [/^https:\/\/aa9986087-cyber\.github\.io$/, /^https:\/\/mafia-server\.vamosx\.workers\.dev$/, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

export class MafiaGame extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.timer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const create = url.searchParams.get("create") === "1";
    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    const fail = (reason) => {
      ws.send(JSON.stringify({ t: "error", reason }));
      ws.close(1000, reason);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (!this.room && !create) return fail("not_found");
    if (this.room && create && this.room.players.size) return fail("exists");
    if (!this.room) this.room = new MafiaRoom(url.searchParams.get("code"));
    const room = this.room;
    const conn = { send: (s) => ws.send(s), close: () => ws.close(1000) };
    room.connect(conn);
    ws.addEventListener("message", (e) => room.message(conn, typeof e.data === "string" ? e.data : ""));
    ws.addEventListener("close", () => room.disconnect(conn));
    ws.addEventListener("error", () => room.disconnect(conn));
    if (!this.timer) {
      this.timer = setInterval(() => {
        room.tick();
        if (room.isDead()) { clearInterval(this.timer); this.timer = null; this.room = null; }
      }, MAFIA_TICK_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]+)$/);
    if (!m) return new Response("not found", { status: 404 }); // pages are served as static assets before this
    if (!ORIGINS.some((re) => re.test(request.headers.get("Origin") || ""))) return new Response("forbidden", { status: 403 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const code = normalizeCode(m[1]);
    if (!isValidCode(code)) return new Response("bad code", { status: 400 });
    const inner = new URL(request.url);
    inner.searchParams.set("code", code);
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(inner, request));
  }
};
