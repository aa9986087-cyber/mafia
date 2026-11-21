// Local server for testing: the same rooms over WebSocket at ws://localhost:8787/ws/<code>.
// Pair it with the pages: python3 -m http.server 8080 in the repository root, then open
// http://localhost:8080/?server=ws://localhost:8787
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { MafiaRoom, MAFIA_TICK_MS } from "./room.js";
import { CODE_CHARS } from "./codes.js";

const rooms = new Map();
const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end("خادم مافيا المحلي"); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]+)$/);
  const code = m && m[1];
  if (!code || code.length !== 5 || ![...code].every((c) => CODE_CHARS.includes(c))) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const create = url.searchParams.get("create") === "1";
    let room = rooms.get(code);
    const fail = (reason) => { ws.send(JSON.stringify({ t: "error", reason })); ws.close(); };
    if (!room && !create) return fail("not_found");
    if (room && create && room.players.size) return fail("exists");
    if (!room) {
      room = new MafiaRoom(code);
      room.timer = setInterval(() => { room.tick(); if (room.isDead()) { clearInterval(room.timer); rooms.delete(code); } }, MAFIA_TICK_MS);
      rooms.set(code, room);
    }
    const conn = { send: (s) => ws.readyState === 1 && ws.send(s), close: () => ws.close() };
    room.connect(conn);
    ws.on("message", (data) => room.message(conn, data.toString()));
    ws.on("close", () => room.disconnect(conn));
    ws.on("error", () => room.disconnect(conn));
  });
});
const port = Number(process.env.PORT) || 8787;
server.listen(port, () => console.log(`خادم مافيا على ws://localhost:${port}`));
