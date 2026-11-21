import { test } from "node:test";
import assert from "node:assert/strict";
import { MafiaRoom, TIMES, maxMafia } from "../room.js";

function setup(n = 6, settings = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const room = new MafiaRoom("MAFIA", { now: clock.now, random });
  const conns = [];
  for (let i = 0; i < n; i++) {
    const conn = { inbox: [], send(s) { this.inbox.push(JSON.parse(s)); }, close() { this.closed = true; } };
    room.connect(conn);
    room.message(conn, { t: "hello", name: "لاعب" + i });
    conns.push(conn);
  }
  Object.assign(room.settings, settings);
  const ids = conns.map((c) => c.inbox.find((m) => m.t === "welcome").id);
  const send = (i, msg) => room.message(conns[i], msg);
  const p = (i) => room.players.get(ids[i]);
  const idx = (pl) => ids.indexOf(pl.id);
  const state = (i) => { room.tick(); return conns[i].inbox.filter((m) => m.t === "state").at(-1); };
  const byRole = (role) => [...room.players.values()].filter((x) => x.role === role).map(idx);
  const toNight = () => { send(0, { t: "start" }); ids.forEach((_, i) => send(i, { t: "seen" })); room.tick(); clock.advance(3000); room.tick(); };
  return { room, clock, conns, ids, send, p, idx, state, byRole, toNight };
}

test("roles: the right number of each, and a third of the table at most is mafia", () => {
  assert.equal(maxMafia(4), 1);
  assert.equal(maxMafia(7), 2);
  assert.equal(maxMafia(10), 3);
  const g = setup(7, { mafia: 4 });
  g.send(0, { t: "start" });
  assert.equal(g.room.phase, "reveal");
  assert.equal(g.byRole("mafia").length, 2, "capped at a third");
  assert.equal(g.byRole("doctor").length, 1);
  assert.equal(g.byRole("detective").length, 1);
  assert.equal(g.byRole("citizen").length, 3);
  const g2 = setup(5, { doctor: false, detective: false });
  g2.send(0, { t: "start" });
  assert.equal(g2.byRole("doctor").length + g2.byRole("detective").length, 0);
});

test("only the host starts, and only with four players", () => {
  const g = setup(3);
  g.send(0, { t: "start" });
  assert.equal(g.room.phase, "lobby");
  const g2 = setup(4);
  g2.send(1, { t: "start" });
  assert.equal(g2.room.phase, "lobby");
  g2.send(0, { t: "start" });
  assert.equal(g2.room.phase, "reveal");
});

test("roles stay secret: each sees their own, mafia see each other, everyone sees all at the end", () => {
  const g = setup(8, { mafia: 2 });
  g.send(0, { t: "start" });
  const [m1, m2] = g.byRole("mafia");
  const citizen = g.byRole("citizen")[0];
  const cs = g.state(citizen);
  assert.equal(cs.players.filter((p) => p.role !== undefined).length, 1, "a citizen sees only their own role");
  const ms = g.state(m1);
  assert.deepEqual(ms.players.filter((p) => p.role).map((p) => p.role).sort(), ["mafia", "mafia"]);
  assert.ok(ms.players.find((p) => p.id === g.ids[m2]).role === "mafia");
  g.room.finish("town");
  assert.equal(g.state(citizen).players.every((p) => p.role), true);
});

test("night: the mafia kill, the doctor saves, the detective learns, and citizens' picks change nothing", () => {
  const g = setup(6);
  g.toNight();
  assert.equal(g.room.phase, "night");
  const [m] = g.byRole("mafia");
  const [d] = g.byRole("doctor");
  const [det] = g.byRole("detective");
  const cits = g.byRole("citizen");
  const victim = cits[0];
  g.send(m, { t: "pick", target: g.ids[victim] });
  g.send(d, { t: "pick", target: g.ids[victim] });
  g.send(det, { t: "pick", target: g.ids[m] });
  g.send(cits[1], { t: "pick", target: g.ids[cits[2]] });
  assert.deepEqual(g.p(det).results.at(-1), { round: 1, id: g.ids[m], mafia: true });
  g.room.tick();
  assert.equal(g.room.phase, "morning", "the night ends once every role has acted");
  assert.equal(g.room.morning.saved, true);
  assert.equal(g.room.morning.killed, null);
  assert.equal(g.p(victim).alive, true);
  // Next night the doctor may not protect the same person again.
  g.clock.advance(TIMES.morning); g.room.tick();
  g.room.startNight();
  g.send(d, { t: "pick", target: g.ids[victim] });
  assert.equal(g.p(d).pick, null);
  g.send(m, { t: "pick", target: g.ids[victim] });
  g.send(d, { t: "pick", target: g.ids[cits[1]] });
  g.send(det, { t: "pick", target: g.ids[cits[1]] });
  g.room.tick();
  assert.equal(g.room.morning.killed, g.ids[victim]);
  assert.equal(g.p(victim).alive, false);
});

test("the doctor protecting themself follows the room setting", () => {
  const g = setup(5, { doctorSelf: false });
  g.toNight();
  const [d] = g.byRole("doctor");
  g.send(d, { t: "pick", target: g.ids[d] });
  assert.equal(g.p(d).pick, null);
  const g2 = setup(5, { doctorSelf: true });
  g2.toNight();
  const [d2] = g2.byRole("doctor");
  g2.send(d2, { t: "pick", target: g2.ids[d2] });
  assert.equal(g2.p(d2).pick, g2.ids[d2]);
});

test("two mafia must agree; the night waits for them, then times out with the most picked victim", () => {
  const g = setup(8, { mafia: 2, doctor: false, detective: false });
  g.toNight();
  const [m1, m2] = g.byRole("mafia");
  const [c1, c2] = g.byRole("citizen");
  g.send(m1, { t: "pick", target: g.ids[c1] });
  g.send(m2, { t: "pick", target: g.ids[c2] });
  g.send(m1, { t: "mchat", text: "خلنا على الثاني" });
  assert.equal(g.state(m2).night.chat.at(-1).text, "خلنا على الثاني");
  assert.equal(g.state(c1).night.chat, undefined, "citizens never see the mafia chat");
  g.room.tick();
  assert.equal(g.room.phase, "night", "they disagree, so the night goes on");
  g.send(m1, { t: "pick", target: g.ids[c2] });
  g.room.tick();
  assert.equal(g.room.morning.killed, g.ids[c2]);
});

test("day: ready to vote with a majority, a tie removes nobody, a clear vote removes one", () => {
  const g = setup(6, { doctor: false, detective: false });
  g.toNight();
  g.clock.advance(g.room.settings.night * 1000); g.room.tick(); // nobody picked: quiet night
  assert.equal(g.room.morning.killed, null);
  g.clock.advance(TIMES.morning); g.room.tick();
  assert.equal(g.room.phase, "discuss");
  for (let i = 0; i < 3; i++) g.send(i, { t: "ready" });
  assert.equal(g.room.phase, "discuss", "half is not a majority");
  g.send(3, { t: "ready" });
  assert.equal(g.room.phase, "vote");
  // Tie: two and two, two skip.
  g.send(0, { t: "vote", target: g.ids[1] }); g.send(2, { t: "vote", target: g.ids[1] });
  g.send(1, { t: "vote", target: g.ids[0] }); g.send(3, { t: "vote", target: g.ids[0] });
  g.send(4, { t: "vote", target: "skip" }); g.send(5, { t: "vote", target: "skip" });
  g.room.tick();
  assert.equal(g.room.phase, "result");
  assert.equal(g.room.result.target, null);
  assert.equal(g.room.result.tie, true);
  g.clock.advance(TIMES.result); g.room.tick();
  assert.equal(g.room.phase, "night");
});

test("the citizens win when the mafia is voted out, and a new round starts in the same room", () => {
  const g = setup(5, { doctor: false, detective: false });
  g.toNight();
  const [m] = g.byRole("mafia");
  g.clock.advance(g.room.settings.night * 1000); g.room.tick();
  g.clock.advance(TIMES.morning); g.room.tick();
  g.room.startVote();
  g.ids.forEach((_, i) => i !== m && g.send(i, { t: "vote", target: g.ids[m] }));
  g.send(m, { t: "vote", target: "skip" });
  g.room.tick();
  assert.equal(g.room.result.target, g.ids[m]);
  g.clock.advance(TIMES.result); g.room.tick();
  assert.equal(g.room.phase, "end");
  assert.equal(g.room.winner, "town");
  g.send(0, { t: "again" });
  assert.equal(g.room.phase, "lobby");
  assert.equal(g.room.players.size, 5);
  assert.ok([...g.room.players.values()].every((p) => p.alive && p.role === "citizen"));
});

test("the mafia win once they are as many as the others", () => {
  const g = setup(4, { doctor: false, detective: false });
  g.toNight();
  const [m] = g.byRole("mafia");
  const others = g.byRole("citizen");
  g.send(m, { t: "pick", target: g.ids[others[0]] });
  g.room.tick();
  g.clock.advance(TIMES.morning); g.room.tick();
  g.room.startVote();
  g.send(others[1], { t: "vote", target: g.ids[others[2]] });
  g.send(m, { t: "vote", target: g.ids[others[2]] });
  g.room.endVote();
  g.clock.advance(TIMES.result); g.room.tick();
  assert.equal(g.room.winner, "mafia");
});

test("someone who drops out: their seat waits a minute, then they leave the round and nobody waits for them", () => {
  const g = setup(6);
  g.toNight();
  const [det] = g.byRole("detective");
  g.room.disconnect(g.conns[det]);
  g.clock.advance(TIMES.gameGrace - 1000); g.room.tick();
  assert.equal(g.p(det).left, false, "still has time to come back");
  // Coming back with the same token keeps the seat and the role.
  const back = { inbox: [], send(s) { this.inbox.push(JSON.parse(s)); }, close() {} };
  g.room.connect(back);
  g.room.message(back, { t: "hello", token: g.p(det).token });
  assert.equal(g.p(det).connected, true);
  assert.equal(g.p(det).role, "detective");
  g.room.disconnect(back);
  g.clock.advance(TIMES.gameGrace); g.room.tick();
  assert.equal(g.p(det).left, true);
  assert.equal(g.p(det).alive, false);
  // The night now ends without the detective.
  const [m] = g.byRole("mafia"), [d] = g.byRole("doctor"), [c] = g.byRole("citizen");
  if (g.room.phase === "night") {
    g.send(m, { t: "pick", target: g.ids[c] });
    g.send(d, { t: "pick", target: g.ids[d] });
    g.room.tick();
    assert.equal(g.room.phase, "morning");
  }
});

test("the host role moves on when the host leaves, and late joiners cannot enter a running game", () => {
  const g = setup(5);
  g.room.disconnect(g.conns[0]);
  assert.equal(g.p(1).host, true);
  g.send(1, { t: "start" });
  assert.equal(g.room.phase, "reveal");
  const late = { inbox: [], send(s) { this.inbox.push(JSON.parse(s)); }, close() { this.closed = true; } };
  g.room.connect(late);
  g.room.message(late, { t: "hello", name: "متأخر" });
  assert.equal(late.inbox[0].reason, "started");
});

test("a whole random match always ends with a winner", () => {
  for (let run = 0; run < 30; run++) {
    const g = setup(4 + (run % 9), { mafia: 1 + (run % 3) });
    g.toNight();
    for (let step = 0; step < 4000 && g.room.phase !== "end"; step++) {
      const alive = g.room.living();
      const pickFrom = (p) => alive.filter((x) => x !== p && !(p.role === "mafia" && x.role === "mafia"));
      for (const p of alive) {
        const i = g.idx(p);
        const choices = pickFrom(p);
        const any = choices[(step + i) % Math.max(1, choices.length)];
        if (g.room.phase === "night" && any) g.send(i, { t: "pick", target: any.id });
        if (g.room.phase === "discuss") g.send(i, { t: "ready" });
        if (g.room.phase === "vote" && any) g.send(i, { t: "vote", target: (step + i) % 4 ? any.id : "skip" });
      }
      g.clock.advance(1000);
      g.room.tick();
    }
    assert.equal(g.room.phase, "end", `run ${run} finished`);
    assert.ok(["town", "mafia"].includes(g.room.winner));
  }
});

test("bots: the host adds them in the lobby, they never host, and a room of only bots is empty", () => {
  const g = setup(1);
  g.send(0, { t: "bots", n: 5 });
  assert.equal(g.room.players.size, 6);
  assert.equal(g.state(0).players.filter((p) => p.bot).length, 5);
  g.send(0, { t: "bots", n: 3 });
  assert.equal(g.room.players.size, 4);
  g.room.disconnect(g.conns[0]);
  assert.equal([...g.room.players.values()].some((p) => p.bot && p.host), false);
  assert.equal(g.room.isEmpty(), true);
  const g2 = setup(2);
  g2.send(1, { t: "bots", n: 3 });
  assert.equal(g2.room.players.size, 2, "only the host adds bots");
});

test("one person and bots play whole matches: bots look at their cards, act at night and vote", () => {
  for (let run = 0; run < 12; run++) {
    const g = setup(1, { mafia: 1 + (run % 2) });
    g.send(0, { t: "bots", n: 4 + (run % 6) });
    g.send(0, { t: "start" });
    g.send(0, { t: "seen" });
    let nights = 0;
    for (let step = 0; step < 6000 && g.room.phase !== "end"; step++) {
      if (g.room.phase === "night" && nights < g.room.round) nights = g.room.round;
      // The person just goes along: vote skip and stay quiet.
      if (g.room.phase === "vote" && g.p(0).alive && g.p(0).vote === undefined) g.send(0, { t: "vote", target: "skip" });
      g.clock.advance(500);
      g.room.tick();
    }
    assert.equal(g.room.phase, "end", `run ${run} finished`);
    assert.ok(nights >= 1);
  }
});

test("the host can kick someone: in the lobby they are gone, in a game they are out, and they may come back", () => {
  const g = setup(6, { doctor: false, detective: false });
  assert.equal(g.room.players.size, 6);
  g.send(1, { t: "kick", target: g.ids[2] });
  assert.equal(g.room.players.size, 6, "only the host can kick");
  g.send(0, { t: "kick", target: g.ids[5] });
  assert.equal(g.room.players.size, 5);
  assert.equal(g.conns[5].inbox.at(-1).reason, "kicked");
  // They can come straight back with the room code.
  const back = { inbox: [], send(s) { this.inbox.push(JSON.parse(s)); }, close() {} };
  g.room.connect(back);
  g.room.message(back, { t: "hello", name: "رجع" });
  assert.equal(back.inbox[0].t, "welcome");
  assert.equal(g.room.players.size, 6);
  g.room.disconnect(back);
  g.room.players.delete(back.inbox[0].id);
  g.toNight();
  const victim = [...g.byRole("citizen"), ...g.byRole("mafia")].find((i) => i !== 0);
  g.send(0, { t: "kick", target: g.ids[victim] });
  assert.equal(g.p(victim).left, true);
  assert.equal(g.p(victim).alive, false);
  g.send(0, { t: "bots", n: 2 });
  assert.equal([...g.room.players.values()].some((p) => p.bot), false, "bots are added only in the lobby");
});

test("with bots, the vote starts as soon as the people are ready, and bots vote within seconds", () => {
  const g = setup(1, { doctor: false, detective: false });
  g.send(0, { t: "bots", n: 5 });
  g.send(0, { t: "start" });
  g.send(0, { t: "seen" });
  for (let i = 0; i < 200 && g.room.phase !== "discuss" && g.room.phase !== "end"; i++) { g.clock.advance(500); g.room.tick(); }
  if (g.room.phase === "end" || !g.p(0).alive) return; // the person was the night's victim: nothing to check
  g.room.tick();
  assert.equal(g.room.phase, "discuss", "bots alone do not start the vote");
  g.send(0, { t: "ready" });
  g.room.tick();
  assert.equal(g.room.phase, "vote", "one ready person is a majority of the people");
  for (let i = 0; i < 8; i++) { g.clock.advance(500); g.room.tick(); }
  const bots = g.room.living().filter((p) => p.bot);
  assert.ok(bots.every((p) => p.vote !== undefined) || g.room.phase !== "vote", "bots voted within four seconds");
});
