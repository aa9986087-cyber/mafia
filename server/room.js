// Mafia room: the whole game runs here and nowhere else. Roles never leave the server except to the people
// allowed to see them. No network code: adapters (worker.js on Cloudflare, dev.mjs locally) hand it
// connections ({ send(string), close() }) and call tick() every MAFIA_TICK_MS.

export const MAFIA_TICK_MS = 250;
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 16;

// Host settings: numbers are seconds or counts; flags are on/off. Sent to the lobby so the page needs no copy.
export const SETTINGS = {
  mafia: { label: "عدد المافيا", min: 1, max: 4, step: 1, def: 1 },
  night: { label: "وقت الليل", unit: "ث", min: 20, max: 120, step: 5, def: 45 },
  discuss: { label: "وقت النقاش", unit: "ث", min: 30, max: 300, step: 30, def: 120 },
  vote: { label: "وقت التصويت", unit: "ث", min: 15, max: 90, step: 15, def: 45 },
  doctor: { label: "الطبيب", flag: true, def: true },
  detective: { label: "المحقق", flag: true, def: true },
  doctorSelf: { label: "الطبيب يحمي نفسه", flag: true, def: true }
};

export const TIMES = {
  reveal: 25000, // ends sooner once everyone has looked at their card
  morning: 8000,
  result: 8000,
  lobbyGrace: 30000, // a lobby seat is kept this long after a disconnect
  gameGrace: 60000, // in a game: this long to come back before counting as gone
  emptyRoom: 5 * 60000
};

const BOT_NAMES = ["فهد", "ناصر", "سلطان", "بدر", "خالد", "تركي", "سعود", "فيصل", "عبدالله", "مشاري", "نواف", "راكان", "ماجد", "حمد", "عبدالعزيز"];

export const ROLES = { mafia: "مافيا", doctor: "طبيب", detective: "محقق", citizen: "مواطن" };

/** At most a third of the table can be mafia (rounded down, at least one). */
export const maxMafia = (n) => Math.max(1, Math.floor((n - 1) / 3));

const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
const cleanText = (s) => String(s || "").replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, "").trim().slice(0, 140);

export class MafiaRoom {
  constructor(code, { now = () => Date.now(), random = Math.random } = {}) {
    this.code = code;
    this.now = now;
    this.random = random;
    this.players = new Map(); // id -> player, in join order
    this.conns = new Map(); // conn -> player id
    this.settings = Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, d.def]));
    this.seq = 0;
    this.emptySince = now();
    this.reset();
  }

  reset() {
    this.phase = "lobby"; // lobby | reveal | night | morning | discuss | vote | result | end
    this.deadline = 0;
    this.round = 0;
    this.morning = null; // { killed, saved }
    this.result = null; // { target, tie, votes, counts }
    this.winner = null;
    this.nightChat = [];
    this.dayChat = [];
    this.dirty = true;
  }

  // ---------- connections ----------

  connect(conn) { this.conns.set(conn, null); }

  disconnect(conn) {
    const id = this.conns.get(conn);
    this.conns.delete(conn);
    const p = id && this.players.get(id);
    if (!p || p.conn !== conn) return;
    p.conn = null;
    p.connected = false;
    p.disconnectedAt = this.now();
    if (p.host) this.passHost();
    this.dirty = true;
  }

  /** Bots keep nobody company: a room with only bots in it is empty. */
  isEmpty() { return ![...this.players.values()].some((p) => p.connected && !p.bot); }
  isDead() { return this.isEmpty() && this.now() - this.emptySince > TIMES.emptyRoom; }

  send(p, msg) { if (p.conn && !p.bot) try { p.conn.send(JSON.stringify(msg)); } catch { /* socket gone */ } }
  sendConn(conn, msg) { try { conn.send(JSON.stringify(msg)); } catch { /* socket gone */ } }

  message(conn, raw) {
    let msg;
    try { msg = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    if (msg.t === "ping") return this.sendConn(conn, { t: "pong", c: msg.c, now: this.now() });
    if (msg.t === "hello") return this.hello(conn, msg);
    const p = this.players.get(this.conns.get(conn));
    if (!p || p.conn !== conn) return;
    const h = HANDLERS[msg.t];
    if (h) h.call(this, p, msg);
  }

  hello(conn, msg) {
    const token = String(msg.token || "").slice(0, 64);
    let p = token && [...this.players.values()].find((x) => x.token === token);
    if (p) {
      if (p.conn && p.conn !== conn) { this.conns.delete(p.conn); try { p.conn.close(); } catch { /* gone */ } }
    } else {
      if (this.phase !== "lobby") return this.reject(conn, "started");
      if (this.players.size >= MAX_PLAYERS) return this.reject(conn, "full");
      p = this.addPlayer(msg);
    }
    p.conn = conn;
    p.connected = true;
    p.disconnectedAt = 0;
    this.conns.set(conn, p.id);
    if (![...this.players.values()].some((x) => x.host && x.connected && x !== p)) {
      for (const x of this.players.values()) x.host = false;
      p.host = true;
    }
    this.sendConn(conn, { t: "welcome", id: p.id, token: p.token, code: this.code });
    this.dirty = true;
  }

  reject(conn, reason) {
    this.sendConn(conn, { t: "error", reason });
    try { conn.close(); } catch { /* gone */ }
  }

  addPlayer(msg) {
    const id = "m" + (++this.seq).toString(36);
    const token = Math.floor(this.random() * 2 ** 48).toString(36) + id + Math.floor(this.random() * 2 ** 32).toString(36);
    const p = {
      id, token, name: this.uniqueName(cleanName(msg.name) || "ضيف"), conn: null, connected: true, disconnectedAt: 0,
      host: false, role: "citizen", alive: true, left: false, ready: false, pick: null, vote: undefined,
      lastProtect: null, results: [], bot: false, actAt: 0
    };
    this.players.set(id, p);
    return p;
  }

  uniqueName(name, self) {
    const taken = new Set([...this.players.values()].filter((x) => x !== self).map((x) => x.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
  }

  passHost() {
    const next = [...this.players.values()].find((x) => x.connected && !x.left && !x.bot);
    if (!next) return;
    for (const x of this.players.values()) x.host = x === next;
  }

  // ---------- helpers ----------

  living() { return [...this.players.values()].filter((p) => p.alive && !p.left); }
  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  /** Who still has to act tonight: living, connected players with a night role. */
  nightActors() { return this.living().filter((p) => p.connected && p.role !== "citizen"); }

  // ---------- game flow ----------

  start() {
    for (const p of [...this.players.values()]) if (!p.connected) this.players.delete(p.id);
    const list = [...this.players.values()];
    const n = list.length;
    const mafia = Math.min(this.settings.mafia, maxMafia(n));
    const order = this.shuffle(list.slice());
    const roles = [];
    for (let i = 0; i < mafia; i++) roles.push("mafia");
    if (this.settings.doctor) roles.push("doctor");
    if (this.settings.detective) roles.push("detective");
    while (roles.length < n) roles.push("citizen");
    order.forEach((p, i) => {
      Object.assign(p, { role: roles[i], alive: true, left: false, ready: false, pick: null, vote: undefined, lastProtect: null, results: [], actAt: 0 });
    });
    this.reset();
    this.phase = "reveal";
    this.deadline = this.now() + TIMES.reveal;
  }

  startNight() {
    this.round++;
    this.phase = "night";
    this.deadline = this.now() + this.settings.night * 1000;
    this.nightChat = [];
    for (const p of this.players.values()) { p.pick = null; p.ready = false; p.vote = undefined; p.actAt = 0; }
    this.dirty = true;
  }

  /** The mafia's victim: the most picked target among living mafia (a tie is settled at random). */
  mafiaTarget() {
    const counts = new Map();
    for (const m of this.living().filter((p) => p.role === "mafia")) if (m.pick) counts.set(m.pick, (counts.get(m.pick) || 0) + 1);
    let best = 0, top = [];
    for (const [id, n] of counts) { if (n > best) { best = n; top = [id]; } else if (n === best) top.push(id); }
    return top.length ? top[Math.floor(this.random() * top.length)] : null;
  }

  /** Tonight is over early once every role holder has chosen and the mafia agree on one victim. */
  nightDone() {
    const actors = this.nightActors();
    if (!actors.every((p) => p.pick)) return false;
    const picks = new Set(actors.filter((p) => p.role === "mafia").map((p) => p.pick));
    return picks.size <= 1;
  }

  endNight() {
    const targetId = this.mafiaTarget();
    const doctor = this.living().find((p) => p.role === "doctor");
    const target = targetId && this.players.get(targetId);
    const saved = !!(target && doctor && doctor.pick === target.id);
    if (target && !saved && target.alive) target.alive = false;
    if (doctor) doctor.lastProtect = doctor.pick;
    for (const p of this.players.values()) if (p.role === "doctor" && p !== doctor) p.lastProtect = null;
    this.morning = { killed: target && !saved ? target.id : null, saved, round: this.round };
    this.phase = "morning";
    this.deadline = this.now() + TIMES.morning;
    this.dirty = true;
  }

  /** The people who actually talk: living humans still connected. Bots never hold the discussion up. */
  talkers() { return this.living().filter((p) => !p.bot && p.connected); }

  /** The vote starts once more than half of the people are ready (with no people left, straight away). */
  readyToVote() {
    if (this.phase !== "discuss") return false;
    const people = this.talkers();
    if (!people.length) return true; // only bots (or nobody connected) left alive: nothing to wait for
    return people.filter((p) => p.ready).length * 2 > people.length;
  }

  startDiscussion() {
    this.phase = "discuss";
    this.dayChat = [];
    this.deadline = this.now() + this.settings.discuss * 1000;
    for (const p of this.players.values()) p.ready = false;
    this.dirty = true;
  }

  startVote() {
    this.phase = "vote";
    this.deadline = this.now() + this.settings.vote * 1000;
    for (const p of this.players.values()) { p.vote = undefined; p.ready = false; p.actAt = 0; }
    this.dirty = true;
  }

  endVote() {
    const counts = {};
    const votes = {};
    for (const p of this.living()) {
      if (p.vote === undefined) continue;
      votes[p.id] = p.vote;
      counts[p.vote] = (counts[p.vote] || 0) + 1;
    }
    let best = 0, top = [];
    for (const [id, n] of Object.entries(counts)) { if (n > best) { best = n; top = [id]; } else if (n === best) top.push(id); }
    const tie = top.length > 1;
    const targetId = !tie && top[0] && top[0] !== "skip" ? top[0] : null;
    const target = targetId && this.players.get(targetId);
    if (target) target.alive = false;
    this.result = { target: target ? target.id : null, tie, skipped: !tie && top[0] === "skip", votes, counts, round: this.round };
    this.phase = "result";
    this.deadline = this.now() + TIMES.result;
    this.dirty = true;
  }

  /** Citizens win when no mafia is left; the mafia win once they are as many as everyone else alive. */
  checkWin() {
    if (this.phase === "lobby" || this.phase === "end") return false;
    const alive = this.living();
    const mafia = alive.filter((p) => p.role === "mafia").length;
    if (mafia === 0) return this.finish("town");
    if (mafia >= alive.length - mafia) return this.finish("mafia");
    return false;
  }

  finish(winner) {
    this.phase = "end";
    this.winner = winner;
    this.deadline = 0;
    this.dirty = true;
    return true;
  }

  backToLobby() {
    for (const p of [...this.players.values()]) {
      if (!p.connected) { this.players.delete(p.id); continue; }
      Object.assign(p, { role: "citizen", alive: true, left: false, ready: false, pick: null, vote: undefined, lastProtect: null, results: [] });
    }
    this.reset();
    if (![...this.players.values()].some((p) => p.host && p.connected)) this.passHost();
  }

  /** Someone gone for good mid-game: out of the round, and the game goes on without waiting for them. */
  dropOut(p) {
    if (this.phase === "lobby") { this.players.delete(p.id); if (p.host) this.passHost(); this.dirty = true; return; }
    if (p.left) return;
    p.left = true;
    p.alive = false;
    p.pick = null;
    p.vote = undefined;
    if (p.host) this.passHost();
    this.dirty = true;
    this.checkWin();
  }

  // ---------- bots ----------

  /** The host fills the table with computer players (lobby only). */
  setBots(n) {
    const bots = [...this.players.values()].filter((p) => p.bot);
    n = Math.max(0, Math.min(n, bots.length + MAX_PLAYERS - this.players.size));
    while (bots.length < n) {
      const used = new Set([...this.players.values()].map((p) => p.name));
      const name = BOT_NAMES.find((x) => !used.has(x)) || "بوت";
      const p = this.addPlayer({ name });
      Object.assign(p, { bot: true, connected: true, token: "" });
      bots.push(p);
    }
    while (bots.length > n) this.players.delete(bots.pop().id);
    this.dirty = true;
  }

  /** A bot acts once its own little thinking time has passed, so it never answers instantly. */
  botReady(p, now, min, spread) {
    if (!p.actAt) { p.actAt = now + min + this.random() * spread; return false; }
    if (now < p.actAt) return false;
    p.actAt = 0;
    return true;
  }

  runBots(now) {
    const bots = [...this.players.values()].filter((p) => p.bot);
    if (!bots.length) return;
    const pickOne = (list) => list[Math.floor(this.random() * list.length)];
    for (const b of bots) {
      if (this.phase === "reveal") { if (!b.ready && this.botReady(b, now, 1500, 3000)) HANDLERS.seen.call(this, b); continue; }
      if (!b.alive || b.left) continue;
      if (this.phase === "night" && !b.pick) {
        if (!this.botReady(b, now, 2000, 3000)) continue;
        const alive = this.living().filter((x) => x !== b);
        let target;
        if (b.role === "mafia") {
          // Follow a fellow mafia's choice if there is one, so they agree.
          const mate = this.living().find((x) => x.role === "mafia" && x !== b && x.pick);
          target = mate ? this.players.get(mate.pick) : pickOne(alive.filter((x) => x.role !== "mafia"));
        } else if (b.role === "doctor") {
          const allowed = this.living().filter((x) => x.id !== b.lastProtect && (x !== b || this.settings.doctorSelf));
          target = pickOne(allowed);
        } else if (b.role === "detective") {
          const checked = new Set(b.results.map((r) => r.id));
          target = pickOne(alive.filter((x) => !checked.has(x.id))) || pickOne(alive);
        } else target = pickOne(alive);
        if (target) HANDLERS.pick.call(this, b, { target: target.id });
      } else if (this.phase === "discuss" && !b.ready) {
        // Bots have nothing to say: they are ready at once. Only the people's readiness decides when to vote.
        b.ready = true;
        this.dirty = true;
      } else if (this.phase === "vote" && b.vote === undefined) {
        if (!this.botReady(b, now, 1000, 1500)) continue;
        const alive = this.living().filter((x) => x !== b);
        const caught = b.role === "detective" && b.results.find((r) => r.mafia && this.players.get(r.id)?.alive);
        // Otherwise lean towards whoever already has the most votes, so a round rarely ends in a tie.
        const tally = new Map();
        for (const x of this.living()) if (x.vote && x.vote !== "skip") tally.set(x.vote, (tally.get(x.vote) || 0) + 1);
        const leader = [...tally].sort((a, c) => c[1] - a[1])[0]?.[0];
        let target;
        if (caught) target = caught.id;
        else if (b.role === "mafia") target = (leader && this.players.get(leader)?.role !== "mafia" && leader !== b.id ? leader : pickOne(alive.filter((x) => x.role !== "mafia"))?.id);
        else if (leader && leader !== b.id && this.random() < 0.7) target = leader;
        else target = this.random() < 0.2 ? "skip" : pickOne(alive)?.id;
        HANDLERS.vote.call(this, b, { target: target || "skip" });
      }
    }
  }

  // ---------- tick ----------

  tick() {
    const now = this.now();
    if (!this.isEmpty()) this.emptySince = now;

    for (const p of [...this.players.values()]) {
      if (p.connected || p.left) continue;
      const grace = this.phase === "lobby" || this.phase === "end" ? TIMES.lobbyGrace : TIMES.gameGrace;
      if (now - p.disconnectedAt >= grace) this.dropOut(p);
    }

    this.runBots(now);
    const due = this.deadline && now >= this.deadline;
    switch (this.phase) {
      case "reveal":
        // Once everyone has looked, a few seconds more so the last one can read their card in peace.
        if (!due && this.living().filter((p) => p.connected).every((p) => p.ready)) this.deadline = Math.min(this.deadline, now + 3000);
        if (now >= this.deadline) this.startNight();
        break;
      case "night":
        if (due || this.nightDone()) this.endNight();
        break;
      case "morning":
        if (due && !this.checkWin()) this.startDiscussion();
        break;
      case "discuss":
        if (due || this.readyToVote()) this.startVote();
        break;
      case "vote": {
        const voters = this.living().filter((p) => p.connected);
        if (due || (voters.length && voters.every((p) => p.vote !== undefined))) this.endVote();
        break;
      }
      case "result":
        if (due && !this.checkWin()) this.startNight();
        break;
    }

    if (this.dirty) {
      this.dirty = false;
      for (const p of this.players.values()) if (p.conn) this.send(p, this.view(p));
    }
  }

  /** What one player may know. Roles go only to their owner, to fellow mafia, and to everyone at the end. */
  view(me) {
    const end = this.phase === "end";
    const mafiaEye = me.role === "mafia" && this.phase !== "lobby";
    const players = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, host: p.host, connected: p.connected, alive: p.alive, left: p.left, bot: p.bot,
      ready: this.phase === "discuss" || this.phase === "reveal" ? p.ready : undefined,
      voted: this.phase === "vote" ? p.vote !== undefined : undefined,
      role: end || p === me || (mafiaEye && p.role === "mafia") ? p.role : undefined
    }));
    const v = {
      t: "state", now: this.now(), code: this.code, phase: this.phase, deadline: this.deadline, round: this.round,
      me: me.id, host: me.host, settings: this.settings, players, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS
    };
    if (this.phase === "lobby") { v.limits = SETTINGS; return v; }
    v.role = me.role;
    v.alive = me.alive && !me.left;
    if (this.phase === "night") {
      v.night = { pick: me.pick };
      if (me.role === "mafia") {
        v.night.mates = this.living().filter((p) => p.role === "mafia").map((p) => ({ id: p.id, pick: p.pick }));
        v.night.chat = this.nightChat;
      }
      if (me.role === "doctor") { v.night.lastProtect = me.lastProtect; v.night.self = this.settings.doctorSelf; }
    }
    if (me.role === "detective") v.results = me.results;
    if (this.morning) v.morning = this.morning;
    if (this.phase === "discuss" || this.phase === "vote") v.chat = this.dayChat;
    if (this.phase === "vote") v.myVote = me.vote ?? null;
    if (this.phase === "result" && this.result) v.result = this.result;
    if (this.phase === "discuss") { const people = this.talkers(); v.readyCount = people.filter((p) => p.ready).length; v.readyNeed = Math.floor(people.length / 2) + 1; }
    if (end) v.winner = this.winner;
    return v;
  }
}

// ---------- message handlers (this = room, p = sender) ----------

const HANDLERS = {
  name(p, msg) {
    if (this.phase !== "lobby") return;
    const name = cleanName(msg.name);
    if (name) { p.name = this.uniqueName(name, p); this.dirty = true; }
  },

  /** The host removes someone (a person or a bot). In a game they are out of the round, like someone who left.
   *  They may come back: into the lobby with the room code, or to watch a running game with their old seat. */
  kick(p, msg) {
    if (!p.host) return;
    const t = this.players.get(msg.target);
    if (!t || t === p) return;
    if (t.conn) { const c = t.conn; this.conns.delete(c); t.conn = null; this.reject(c, "kicked"); }
    t.connected = false;
    if (this.phase === "lobby" || t.bot && this.phase === "end") this.players.delete(t.id);
    else { t.left = true; t.alive = false; t.pick = null; t.vote = undefined; this.checkWin(); }
    this.dirty = true;
  },

  bots(p, msg) {
    if (!p.host || this.phase !== "lobby") return;
    const n = Number(msg.n);
    if (Number.isInteger(n)) this.setBots(n);
  },

  settings(p, msg) {
    if (!p.host || this.phase !== "lobby" || !msg.values) return;
    for (const [k, v] of Object.entries(msg.values)) {
      const d = SETTINGS[k];
      if (!d) continue;
      if (d.flag) this.settings[k] = !!v;
      else { const n = Number(v); if (Number.isFinite(n)) this.settings[k] = Math.max(d.min, Math.min(d.max, Math.round(n / d.step) * d.step)); }
    }
    this.dirty = true;
  },

  start(p) {
    if (!p.host || this.phase !== "lobby") return;
    const n = [...this.players.values()].filter((x) => x.connected).length;
    if (n < MIN_PLAYERS) return this.send(p, { t: "toast", text: `تحتاجون ${MIN_PLAYERS} لاعبين على الأقل` });
    this.start();
  },

  /** Seen my card. */
  seen(p) {
    if (this.phase !== "reveal" || p.ready) return;
    p.ready = true;
    this.dirty = true;
  },

  pick(p, msg) {
    if (this.phase !== "night" || !p.alive || p.left) return;
    const t = this.players.get(msg.target);
    if (!t || !t.alive || t.left) return;
    if (p.role === "mafia") {
      if (t.role === "mafia") return;
    } else if (p.role === "doctor") {
      if (t === p && !this.settings.doctorSelf) return this.send(p, { t: "toast", text: "ما يحق لك تحمي نفسك في هذي الغرفة" });
      if (t.id === p.lastProtect) return this.send(p, { t: "toast", text: "حميته الليلة الماضية، اختر غيره" });
    } else if (p.role === "detective") {
      if (p.pick || t === p) return; // one check a night, and not yourself
      p.results.push({ round: this.round, id: t.id, mafia: t.role === "mafia" });
    } else if (t === p) return; // citizens "pick" too, so nobody can tell who has a role
    p.pick = t.id;
    this.dirty = true;
  },

  /** Night chat between mafia members only. */
  mchat(p, msg) {
    if (this.phase !== "night" || p.role !== "mafia" || !p.alive || p.left) return;
    const text = cleanText(msg.text);
    if (!text) return;
    this.nightChat.push({ from: p.id, text });
    if (this.nightChat.length > 40) this.nightChat.shift();
    this.dirty = true;
  },

  /** The day's discussion chat: the living write, everyone reads (those who are out only watch). */
  chat(p, msg) {
    if ((this.phase !== "discuss" && this.phase !== "vote") || !p.alive || p.left) return;
    const text = cleanText(msg.text);
    if (!text) return;
    const now = this.now();
    if (now - (p.lastChatAt || 0) < 700) return; // no flooding
    p.lastChatAt = now;
    this.dayChat.push({ from: p.id, text });
    if (this.dayChat.length > 60) this.dayChat.shift();
    this.dirty = true;
  },

  /** "Ready to vote": once more than half of the living are ready, the vote starts. */
  ready(p, msg) {
    if (this.phase !== "discuss" || !p.alive || p.left) return;
    p.ready = msg.on !== false;
    if (this.readyToVote()) this.startVote();
    this.dirty = true;
  },

  vote(p, msg) {
    if (this.phase !== "vote" || !p.alive || p.left) return;
    if (msg.target === "skip") p.vote = "skip";
    else {
      const t = this.players.get(msg.target);
      if (!t || !t.alive || t.left || t === p) return;
      p.vote = t.id;
    }
    this.dirty = true;
  },

  again(p) {
    if (p.host && this.phase === "end") this.backToLobby();
  },

  leave(p) {
    this.disconnect(p.conn);
    this.dropOut(p);
  }
};
