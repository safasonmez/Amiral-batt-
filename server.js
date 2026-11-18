const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const FLEET = [5, 4, 3, 3, 2];
const NAMES = ["carrier", "battleship", "cruiser", "submarine", "destroyer"];

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) { res.writeHead(500); return res.end("index.html not found next to server.js"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function build(list) {
  if (!Array.isArray(list) || list.length !== FLEET.length) return null;
  const lens = list.map(s => +(s && s.l)).sort((a, b) => a - b).join();
  if (lens !== [...FLEET].sort((a, b) => a - b).join()) return null;
  const cells = Array(100).fill(-1), ships = [];
  for (const s of list) {
    const l = +s.l, i = +s.i, h = !!s.h;
    if (!Number.isInteger(i) || i < 0 || i > 99 || !NAMES.includes(s.n)) return null;
    const r = Math.floor(i / 10), c = i % 10;
    if (h ? c + l > 10 : r + l > 10) return null;
    const cs = [];
    for (let k = 0; k < l; k++) {
      const j = h ? i + k : i + k * 10;
      if (cells[j] >= 0) return null;
      cells[j] = ships.length;
      cs.push(j);
    }
    ships.push({ n: s.n, l, cells: cs, hits: 0 });
  }
  return { cells, ships, shots: Array(100).fill(0) };
}

function newCode() {
  let c;
  do { c = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms.has(c));
  return c;
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  const opp = room.p[1 - ws.idx];
  if (opp) { opp.room = null; send(opp, { t: "oppleft" }); }
  rooms.delete(room.code);
}

wss.on("connection", ws => {
  ws.on("error", () => {});
  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === "create") {
      leave(ws);
      const code = newCode();
      const room = { code, p: [ws, null], b: [null, null], turn: 0, over: false, rm: [false, false] };
      rooms.set(code, room);
      ws.room = room; ws.idx = 0;
      return send(ws, { t: "created", code });
    }
    if (m.t === "join") {
      const room = rooms.get(String(m.code));
      if (!room) return send(ws, { t: "err", k: "notfound" });
      if (room.p[1]) return send(ws, { t: "err", k: "full" });
      leave(ws);
      room.p[1] = ws; ws.room = room; ws.idx = 1;
      send(ws, { t: "joined" });
      return send(room.p[0], { t: "joined" });
    }

    const room = ws.room;
    if (!room) return;
    const me = ws.idx, opp = 1 - me;

    if (m.t === "ready") {
      if (!room.p[1] || room.b[me]) return;
      const b = build(m.ships);
      if (!b) return send(ws, { t: "err", k: "badfleet" });
      room.b[me] = b;
      send(room.p[opp], { t: "oppready" });
      if (room.b[0] && room.b[1]) {
        room.turn = Math.random() < 0.5 ? 0 : 1;
        room.over = false;
        room.p.forEach((p, k) => send(p, { t: "start", first: room.turn === k }));
      }
    } else if (m.t === "fire") {
      if (!room.b[0] || !room.b[1] || room.over || room.turn !== me) return;
      const i = +m.i, b = room.b[opp];
      if (!Number.isInteger(i) || i < 0 || i > 99 || b.shots[i]) return;
      const id = b.cells[i];
      let res = "miss", extra = {};
      if (id < 0) b.shots[i] = 1;
      else {
        b.shots[i] = 2;
        const s = b.ships[id];
        s.hits++;
        res = s.hits === s.l ? "sunk" : "hit";
        if (res === "sunk") { extra.ship = s.n; extra.cells = s.cells; }
      }
      const over = b.ships.every(s => s.hits === s.l);
      if (over) room.over = true; else room.turn = opp;
      const out = { t: "shot", i, res, over, ...extra };
      send(ws, { ...out, who: "you", next: over ? null : "opp" });
      const toOpp = { ...out, who: "opp", next: over ? null : "you" };
      if (over) toOpp.reveal = room.b[me].ships.map(s => ({ n: s.n, cells: s.cells }));
      send(room.p[opp], toOpp);
    } else if (m.t === "rematch") {
      if (!room.over) return;
      room.rm[me] = true;
      send(room.p[opp], { t: "rematch" });
      if (room.rm[0] && room.rm[1]) {
        room.b = [null, null]; room.rm = [false, false]; room.over = false;
        room.p.forEach(p => send(p, { t: "rematchgo" }));
      }
    }
  });
  ws.on("close", () => leave(ws));
});

// keep connections alive on hosting platforms that close idle sockets
setInterval(() => wss.clients.forEach(c => { try { c.ping(); } catch (e) {} }), 25000);

server.listen(PORT, () => console.log("Amiral Batti running: http://localhost:" + PORT));
