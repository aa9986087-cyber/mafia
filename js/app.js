// Mafia: every screen of the game. The server decides everything; this page shows what it sends and passes on
// the player's choices.
import { Net, normalizeCode, isValidCode, randomCode } from "./net.js?v=4";
import { sfx, buzz } from "./sound.js?v=4";

const $ = (id) => document.getElementById(id);
const view = $("view");
const AR = "٠١٢٣٤٥٦٧٨٩";
const ar = (n) => String(n).replace(/\d/g, (d) => AR[d]);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } }
};

const ROLE = {
  mafia: { name: "مافيا", line: "اتفق مع جماعتك كل ليلة على ضحية، وتظاهر بالبراءة في النهار." },
  doctor: { name: "طبيب", line: "كل ليلة اختر شخصًا تحميه من المافيا." },
  detective: { name: "محقق", line: "كل ليلة افحص شخصًا وتعرف سرًا هل هو مافيا أو بريء." },
  citizen: { name: "مواطن", line: "ما عندك قدرة ليلية. ركّز في النقاش واكشف المافيا بالتصويت." }
};
const ICON = {
  mafia: '<svg class="role-icon" viewBox="0 0 64 64"><path d="M10 34c5-1.4 11-2 22-2s17 .6 22 2c-2 4-10 6-22 6s-20-2-22-6Z" fill="#d0263f"/><path d="M19 33c0-9 2.6-17 7.6-17 2.4 0 3.6 2.4 5.4 2.4S35 16 37.4 16C42.4 16 45 24 45 33c-4.6-.8-8.6-1.2-13-1.2s-8.4.4-13 1.2Z" fill="#1c1920" stroke="#d0263f" stroke-width="2"/></svg>',
  doctor: '<svg class="role-icon" viewBox="0 0 64 64"><rect x="12" y="12" width="40" height="40" rx="12" fill="none" stroke="#7fd1b0" stroke-width="3"/><path d="M32 21v22M21 32h22" stroke="#7fd1b0" stroke-width="6" stroke-linecap="round"/></svg>',
  detective: '<svg class="role-icon" viewBox="0 0 64 64"><circle cx="27" cy="27" r="13" fill="none" stroke="#9ec3ff" stroke-width="4"/><path d="m37 37 13 13" stroke="#9ec3ff" stroke-width="6" stroke-linecap="round"/></svg>',
  citizen: '<svg class="role-icon" viewBox="0 0 64 64"><circle cx="32" cy="24" r="10" fill="none" stroke="#d8c08a" stroke-width="3.5"/><path d="M14 52c2-11 9-16 18-16s16 5 18 16" fill="none" stroke="#d8c08a" stroke-width="3.5" stroke-linecap="round"/></svg>'
};
const LOGO = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 35c5-1.4 12-2.2 24-2.2S51 33.6 56 35c-2.6 4-11 6.4-24 6.4S10.6 39 8 35Z" fill="#b89a5e"/><path d="M18 34c0-9.6 2.8-18 8-18 2.4 0 3.8 2.6 6 2.6S35.6 16 38 16c5.2 0 8 8.4 8 18-4.8-.8-9-1.2-14-1.2S22.8 33.2 18 34Z" fill="#1c1920" stroke="#b89a5e" stroke-width="2"/><path d="M19 29.6c4.6-1 8.6-1.3 13-1.3s8.4.3 13 1.3" stroke="#d0263f" stroke-width="3.4"/></svg>';

let S = null; // latest state from the server
let myId = null;
let net = null;
let lastPhaseKey = "";
let picked = null; // instant feedback before the server answers
const serverParam = new URLSearchParams(location.search).get("server"); // test servers only
function setURL(code) {
  const q = new URLSearchParams();
  if (code) q.set("room", code);
  if (serverParam) q.set("server", serverParam);
  try { history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "")); } catch { /* sandboxed */ }
}

// ---------- home ----------

function home(message = "") {
  leaveRoom(false);
  document.body.classList.remove("in-room", "has-mchat");
  document.body.dataset.time = "day";
  $("bar").hidden = true;
  const code = normalizeCode(new URLSearchParams(location.search).get("room"));
  view.innerHTML = `
    <section class="hero enter">${LOGO}<h1 class="title">مافيا</h1>
      <p class="tagline">مافيا بينكم، وطبيب يحمي، ومحقق يفتّش. اكشفوهم قبل ما يخلصون عليكم.</p></section>
    <section class="panel home-card enter">
      <label class="field">اسمك<input id="nameIn" class="input" maxlength="16" autocomplete="nickname" placeholder="مثلًا: أبو فهد" value="${esc(store.get("mafia-name") || "")}"></label>
      ${code ? "" : `<button id="createBtn" class="btn gold block" type="button">أنشئ غرفة</button><div class="divider">أو ادخل برمز الغرفة</div>`}
      <div class="row"><input id="codeIn" class="input code-input" maxlength="5" dir="ltr" autocomplete="off" autocapitalize="characters" placeholder="رمز الغرفة" value="${esc(code)}" aria-label="رمز الغرفة">
        <button id="joinBtn" class="btn ${code ? "gold" : ""}" type="button">ادخل</button></div>
      <p id="homeMsg" class="error" role="alert">${esc(message)}</p>
    </section>
    <details class="rules"><summary>كيف نلعب؟</summary><ul>
      <li><b>المافيا</b> يختارون كل ليلة ضحية.</li>
      <li><b>الطبيب</b> يحمي شخصًا كل ليلة، وما يقدر يحمي نفس الشخص ليلتين ورا بعض.</li>
      <li><b>المحقق</b> يفحص شخصًا كل ليلة ويعرف هل هو مافيا.</li>
      <li><b>المواطنون</b> يتناقشون في النهار ويصوّتون على من يطلع.</li>
      <li>يفوز المواطنون إذا طلعت كل المافيا، وتفوز المافيا إذا صار عددهم مثل عدد الباقين.</li>
    </ul></details>
    <p class="credit">صُنعت في الرافعية بيد <b dir="ltr">Vamos</b></p>`;
  const go = (create) => {
    const name = $("nameIn").value.trim();
    if (!name) { $("homeMsg").textContent = "اكتب اسمك أولًا."; $("nameIn").focus(); return; }
    store.set("mafia-name", name);
    let c = create ? randomCode() : normalizeCode($("codeIn").value);
    if (!create && !isValidCode(c)) { $("homeMsg").textContent = "رمز الغرفة ٥ خانات."; return; }
    sfx.unlock();
    enterRoom(c, create);
  };
  $("createBtn")?.addEventListener("click", () => go(true));
  $("joinBtn").addEventListener("click", () => go(false));
  $("codeIn").addEventListener("keydown", (e) => e.key === "Enter" && go(false));
  $("nameIn").addEventListener("keydown", (e) => e.key === "Enter" && (code ? go(false) : go(true)));
}

// ---------- room connection ----------

function enterRoom(code, create) {
  if (net) return;
  setURL(code);
  document.body.classList.add("in-room");
  $("bar").hidden = false;
  $("barCode").textContent = code;
  view.innerHTML = `<p class="status-line enter">جاري الدخول للغرفة…</p>`;
  net = new Net({ code, create, onMessage, onStatus: (s) => s === "lost" && toast("انقطع الاتصال، نحاول نرجّعك…") });
  net.madeRoom = create;
  net.connect(() => ({ token: store.get("mafia-token-" + code) || "", name: store.get("mafia-name") || "ضيف" }));
}

function leaveRoom(send = true) {
  if (!net) return;
  if (send) net.send({ t: "leave" });
  const code = net.code;
  net.close();
  net = null; S = null; myId = null; lastPhaseKey = "";
  if (send) store.del("mafia-token-" + code);
  $("mchat").hidden = true;
}

function onMessage(msg) {
  if (msg.t === "welcome") { myId = msg.id; store.set("mafia-token-" + msg.code, msg.token); return; }
  if (msg.t === "toast") return toast(msg.text);
  if (msg.t === "error") {
    // A brand-new code that happens to be taken: pick another one quietly.
    if (msg.reason === "exists" && net?.madeRoom) { const n = net; net = null; n.close(); return enterRoom(randomCode(), true); }
    const why = { not_found: "الغرفة غير موجودة أو انتهت.", started: "اللعبة بدأت في هذي الغرفة. انتظروا الجولة الجاية.", full: "الغرفة ممتلئة." }[msg.reason] || "صار خطأ في الاتصال.";
    setURL("");
    return home(why);
  }
  if (msg.t === "state") onState(msg);
}

// ---------- state ----------

const me = () => S?.players.find((p) => p.id === S.me);
const living = () => S.players.filter((p) => p.alive && !p.left);
const nameOf = (id) => S.players.find((p) => p.id === id)?.name ?? "";
const remaining = () => Math.max(0, (S?.deadline || 0) - (net ? net.serverNow() : Date.now()));

function onState(state) {
  const prev = S;
  S = state;
  const key = `${S.phase}:${S.round}`;
  const changed = key !== lastPhaseKey;
  lastPhaseKey = key;
  if (changed) picked = null;
  document.body.dataset.time = S.phase === "night" ? "night" : "day";
  $("peekBtn").hidden = S.phase === "lobby" || S.phase === "reveal" || S.phase === "end";
  if (changed) cue(prev);
  const draw = () => { render(); };
  if (changed && prev && ["night", "morning"].includes(S.phase)) curtain(draw); else draw();
}

/** Sounds and vibrations for the moments that matter. */
function cue(prev) {
  const ph = S.phase;
  if (ph === "night") sfx.night();
  else if (ph === "morning") {
    if (S.morning?.killed === S.me) { sfx.death(); buzz([200, 100, 300]); }
    else if (S.morning?.killed) sfx.death();
    else if (S.morning?.saved) sfx.saved();
    else sfx.morning();
  } else if (ph === "vote") sfx.vote();
  else if (ph === "result" && S.result?.target === S.me) buzz([200, 100, 300]);
  else if (ph === "end") (S.winner === (S.role === "mafia" ? "mafia" : "town") ? sfx.win : sfx.lose)();
  else if (ph === "lobby" && prev && prev.phase !== "lobby") sfx.join();
}

function curtain(then) {
  const c = $("curtain");
  c.classList.add("on");
  setTimeout(() => { then(); c.classList.remove("on"); }, 560);
}

function render() {
  if (!S) return;
  // While a card is being held, only the counter changes: redrawing would snap the card shut in the hand.
  if (S.phase === "reveal" && view.dataset.screen === "reveal" && $("roleCard")) {
    const c = view.querySelector(".seen-count");
    if (c) c.textContent = seenText();
    return;
  }
  const screens = { lobby, reveal, night, morning, discuss, vote, result, end };
  const keepScroll = view.dataset.screen === S.phase ? scrollY : 0;
  view.dataset.screen = S.phase;
  view.innerHTML = screens[S.phase]();
  wire();
  scrollTo(0, keepScroll);
  mafiaChat();
  tickTimers();
}

// ---------- screens ----------

const timerHTML = () => `<div class="timer" data-timer><svg viewBox="0 0 74 74"><circle class="track" cx="37" cy="37" r="32"/><circle class="fill" cx="37" cy="37" r="32"/></svg><b></b></div>`;
const avatarOf = (p) => `<span class="avatar" aria-hidden="true">${esc([...p.name][0] || "؟")}</span>`;
const spectatorNote = () => `<p class="spectator">أنت خارج الجولة. تقدر تتابع، بس ما تقدر تصوّت أو تتدخل.</p>`;

function lobby() {
  const host = S.host;
  const n = S.players.filter((p) => p.connected).length;
  const bots = S.players.filter((p) => p.bot).length;
  const botRow = `<div class="setting"><span>لاعبون آليون</span><div class="stepper">
      <button type="button" data-bots="-1" ${!host || bots <= 0 ? "disabled" : ""} aria-label="أنقص">−</button>
      <b>${ar(bots)}</b>
      <button type="button" data-bots="1" ${!host || S.players.length >= S.maxPlayers ? "disabled" : ""} aria-label="زد">+</button></div></div>`;
  const rows = botRow + Object.entries(S.limits).map(([k, d]) => {
    const v = S.settings[k];
    if (d.flag) return `<div class="setting"><span>${d.label}</span><button class="switch" role="switch" aria-checked="${v}" aria-label="${d.label}" data-flag="${k}" ${host ? "" : "disabled"}></button></div>`;
    return `<div class="setting"><span>${d.label}</span><div class="stepper">
      <button type="button" data-k="${k}" data-d="-1" ${!host || v <= d.min ? "disabled" : ""} aria-label="أنقص">−</button>
      <b>${ar(v)}${d.unit ? " " + d.unit : ""}</b>
      <button type="button" data-k="${k}" data-d="1" ${!host || v >= d.max ? "disabled" : ""} aria-label="زد">+</button></div></div>`;
  }).join("");
  return `
    <section class="panel enter"><div class="room-code"><span class="eyebrow">رمز الغرفة</span><b dir="ltr">${esc(S.code)}</b></div>
      <div class="share-row" style="margin-top:14px"><button class="btn small" data-act="copy" type="button">انسخ الرابط</button><button class="btn small" data-act="share" type="button">شارك</button></div></section>
    <section class="panel enter"><h3 style="margin-bottom:12px">اللاعبون <span class="muted">(${ar(S.players.length)}/${ar(S.maxPlayers)})</span></h3>
      <ul class="players">${S.players.map((p) => `<li class="${p.id === S.me ? "me" : ""} ${p.connected ? "" : "off"}">${avatarOf(p)}<bdi class="nm">${esc(p.name)}</bdi>${p.bot ? '<span class="bot-tag">بوت</span>' : ""}${p.host ? '<span class="crown" title="المضيف" aria-label="المضيف"><svg viewBox="0 0 24 24"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5L3 8Z"/></svg></span>' : ""}</li>`).join("")}</ul></section>
    <section class="panel enter"><h3 style="margin-bottom:6px">إعدادات الغرفة</h3>${host ? "" : '<p class="muted" style="margin:0 0 6px">المضيف هو اللي يعدّلها.</p>'}<div class="settings">${rows}</div></section>
    <div class="foot">
      ${host ? `<button class="btn gold block" data-act="start" type="button" ${n < S.minPlayers ? "disabled" : ""}>ابدأ اللعبة</button>` : ""}
      <p class="muted" style="margin:0">${n < S.minPlayers ? `تحتاجون ${ar(S.minPlayers)} لاعبين على الأقل. أرسلوا الرابط لربعكم${host ? "، أو أضف لاعبين آليين من الإعدادات" : ""}.` : host ? "كل شي جاهز. ابدأ لما يكتمل الجميع." : "بانتظار المضيف يبدأ اللعبة…"}</p>
    </div>`;
}

function roleFront() {
  const r = S.role;
  const mates = r === "mafia" ? S.players.filter((p) => p.role === "mafia" && p.id !== S.me).map((p) => p.name) : [];
  return `<div class="face front role-${r}">${ICON[r]}<div class="role-name">${ROLE[r].name}</div><p>${ROLE[r].line}</p>
    ${mates.length ? `<p class="mates">جماعتك: ${mates.map((m) => `<bdi>${esc(m)}</bdi>`).join("، ")}</p>` : ""}</div>`;
}

function reveal() {
  return `<section class="reveal enter">
    <div class="phase-head" style="width:100%"><div><h2>دورك السري</h2><p>اضغط على البطاقة مطوّلًا لتشوف دورك. تختفي أول ما ترفع إصبعك.</p></div>${timerHTML()}</div>
    <div class="card" id="roleCard"><div class="card-inner">
      <div class="face back">${LOGO}<b>اضغط مطوّلًا</b></div>${roleFront()}</div></div>
    <p class="seen-count">${seenText()}</p></section>`;
}
const seenText = () => `${ar(S.players.filter((p) => p.ready).length)} من ${ar(S.players.filter((p) => !p.left).length)} شافوا أدوارهم`;

/** A grid of players to choose from. options: { exclude(p), disabled(p) -> reason, tags(p) -> html, chosen } */
function choices(list, { action, chosen, disabled = () => "", tags = () => "", mark = () => "" }) {
  return `<ul class="choices">${list.map((p) => {
    const why = disabled(p);
    return `<li><button type="button" class="choice ${chosen === p.id ? "picked" : ""} ${mark(p)}" data-${action}="${p.id}" ${why ? "disabled" : ""}>
      ${avatarOf(p)}<span class="nm"><bdi>${esc(p.name)}</bdi>${why ? `<small>${why}</small>` : ""}</span>${tags(p)}</button></li>`;
  }).join("")}</ul>`;
}

function night() {
  const self = me();
  const alive = living();
  const head = (title, sub) => `<div class="phase-head enter"><div><span class="eyebrow">الليلة ${ar(S.round)}</span><h2>${title}</h2><p>${sub}</p></div>${timerHTML()}</div>`;
  if (!S.alive) return head("الليل", "المدينة نايمة. تابع بصمت.") + spectatorNote();
  const pick = picked ?? S.night?.pick ?? null;
  const r = S.role;
  if (r === "mafia") {
    const mates = S.night.mates || [];
    const votesFor = (id) => mates.filter((m) => m.pick === id).map((m) => nameOf(m.id));
    const agreed = mates.length > 1 && mates.every((m) => m.pick && m.pick === mates[0].pick);
    return head("اختاروا ضحية الليلة", mates.length > 1 ? (agreed ? "اتفقتوا. ننتظر نهاية الليل." : "لازم تتفقون على نفس الشخص.") : "اختر من تتخلص منه.") +
      choices(alive.filter((p) => p.role !== "mafia"), {
        action: "pick", chosen: pick,
        tags: (p) => { const v = votesFor(p.id); return v.length ? `<span class="tags">${v.map((n) => `<span class="tag">${esc(n)}</span>`).join("")}</span>` : ""; },
        mark: (p) => (votesFor(p.id).length ? "mafia-pick" : "")
      });
  }
  if (r === "doctor") {
    return head("من تحمي الليلة؟", "اختر شخصًا تنقذه لو جته المافيا.") + choices(alive, {
      action: "pick", chosen: pick,
      disabled: (p) => (p.id === S.night.lastProtect ? "حميته الليلة الماضية" : p.id === S.me && !S.night.self ? "ما تقدر تحمي نفسك" : "")
    });
  }
  if (r === "detective") {
    const tonight = (S.results || []).find((x) => x.round === S.round);
    const past = (S.results || []).filter((x) => x.round !== S.round);
    const verdict = tonight ? `<div class="verdict ${tonight.mafia ? "bad" : "good"}"><span class="muted"><bdi>${esc(nameOf(tonight.id))}</bdi></span><b>${tonight.mafia ? "مافيا!" : "بريء"}</b></div>` : "";
    return head("من تفحص الليلة؟", tonight ? "عرفت النتيجة. احفظها لنفسك." : "فحص واحد كل ليلة.") + verdict +
      (tonight ? "" : choices(alive.filter((p) => p.id !== S.me), { action: "pick", chosen: pick })) +
      (past.length ? `<section class="panel"><h3 style="margin-bottom:8px;font-size:17px">فحوصاتك السابقة</h3><ul class="history">${past.map((x) => `<li>الليلة ${ar(x.round)}: <bdi>${esc(nameOf(x.id))}</bdi> ${x.mafia ? "مافيا" : "بريء"}</li>`).join("")}</ul></section>` : "");
  }
  // Citizens get the same kind of screen, so nobody nearby can tell who has a role.
  return head("المدينة نايمة", "اختر الشخص اللي تشك فيه. اختيارك ما يأثر، بس يخلي شاشتك مثل الباقين.") +
    choices(alive.filter((p) => p.id !== self.id), { action: "pick", chosen: pick });
}

function morning() {
  const m = S.morning || {};
  const killed = m.killed && S.players.find((p) => p.id === m.killed);
  const mine = m.killed === S.me;
  return `<section class="scene"><div class="sun"></div><span class="eyebrow reveal-in">طلع الصباح</span>
    ${killed ? `<div class="big red reveal-in">${mine ? "المافيا تخلّصت منك" : `المافيا تخلّصت من <bdi>${esc(killed.name)}</bdi>`}</div>
      <p class="sub reveal-in-2">${mine ? "صرت مشاهدًا. لا تكشف شي للباقين." : "انتهت لعبته. الباقون لازم يكشفون القاتل."}</p>`
    : m.saved ? `<div class="big green reveal-in">الطبيب أنقذ الضحية!</div><p class="sub reveal-in-2">حاولت المافيا تتخلص من أحد، بس الطبيب كان أسرع.</p>`
    : `<div class="big reveal-in">ليلة هادئة</div><p class="sub reveal-in-2">ما أحد طلع الليلة.</p>`}
  </section>`;
}

function discuss() {
  const alive = living();
  const ready = S.readyCount || 0;
  const need = Math.floor(alive.length / 2) + 1;
  const mine = me()?.ready;
  return `<div class="phase-head enter"><div><span class="eyebrow">النهار ${ar(S.round)}</span><h2>وقت النقاش</h2><p>تناقشوا: مين تشكّون فيه؟</p></div>${timerHTML()}</div>
    <ul class="alive-list enter">${S.players.filter((p) => !p.left || p.alive).map((p) => `<li class="${p.alive ? "" : "dead"} ${p.ready ? "ready" : ""}"><bdi>${esc(p.name)}</bdi></li>`).join("")}</ul>
    <section class="panel ready-meter enter"><span>جاهزين للتصويت: <b>${ar(ready)}</b> من ${ar(need)}</span><div class="meter"><i style="width:${Math.min(100, (ready / need) * 100)}%"></i></div>
      ${S.alive ? `<button class="btn ${mine ? "" : "gold"} block" data-act="ready" type="button">${mine ? "ألغِ الجاهزية" : "جاهز للتصويت"}</button>` : ""}</section>
    ${S.alive ? "" : spectatorNote()}`;
}

function vote() {
  const my = picked ?? S.myVote;
  const voted = S.players.filter((p) => p.voted).length;
  return `<div class="phase-head enter"><div><span class="eyebrow">التصويت</span><h2>مين تطلّعون؟</h2><p>تقدر تغيّر صوتك لين ينتهي الوقت.</p></div>${timerHTML()}</div>
    ${S.alive ? choices(living().filter((p) => p.id !== S.me), { action: "vote", chosen: my, tags: (p) => (p.voted ? '<span class="tags"><span class="tag" style="background:rgba(184,154,94,.4)">صوّت</span></span>' : "") }) +
      `<button type="button" class="choice skip ${my === "skip" ? "picked" : ""}" data-vote="skip"><span class="nm" style="text-align:center">تخطّي التصويت</span></button>` : spectatorNote()}
    <p class="status-line">صوّت <b>${ar(voted)}</b> من ${ar(living().length)}</p>`;
}

function result() {
  const r = S.result || {};
  const target = r.target && S.players.find((p) => p.id === r.target);
  const counts = Object.entries(r.counts || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...counts.map((c) => c[1]));
  return `<section class="scene"><span class="eyebrow">نتيجة التصويت</span>
    ${target ? `<div class="big red reveal-in">طلع <bdi>${esc(target.name)}</bdi></div><p class="sub reveal-in-2">${target.id === S.me ? "صوّتوا عليك. صرت مشاهدًا." : "هل كان من المافيا؟ بتعرفون في النهاية."}</p>`
      : `<div class="big reveal-in">${r.tie ? "تعادل" : r.skipped ? "تخطّوا التصويت" : "ما أحد صوّت"}</div><p class="sub reveal-in-2">ما أحد طلع هالمرة.</p>`}
    <div class="tally">${counts.map(([id, n]) => `<div class="tally-row"><span class="nm">${id === "skip" ? "تخطّي" : `<bdi>${esc(nameOf(id))}</bdi>`}</span><span class="tally-bar"><i style="width:${(n / max) * 100}%"></i></span><b>${ar(n)}</b></div>`).join("")}</div>
  </section>`;
}

function end() {
  const town = S.winner === "town";
  const order = { mafia: 0, detective: 1, doctor: 2, citizen: 3 };
  const list = S.players.slice().sort((a, b) => order[a.role] - order[b.role]);
  return `<section class="end-banner ${town ? "town" : "mafia"} enter"><span class="eyebrow">انتهت اللعبة</span><h2>${town ? "فاز المواطنون" : "فازت المافيا"}</h2>
      <p class="muted" style="margin:0">${town ? "انكشفت كل المافيا." : "صار عدد المافيا مثل عدد الباقين."}</p></section>
    <section class="panel"><h3 style="margin-bottom:10px">الأدوار</h3><ul class="roles">${list.map((p, i) => `<li style="--i:${i}" class="${p.alive ? "" : "dead"}">${avatarOf(p)}<bdi class="nm">${esc(p.name)}${p.alive ? "" : p.left ? " · غادر" : " · طلع"}</bdi><span class="role-chip ${p.role}">${ROLE[p.role]?.name ?? ""}</span></li>`).join("")}</ul></section>
    <div class="foot">${S.host ? '<button class="btn gold block" data-act="again" type="button">جولة جديدة</button>' : '<p class="muted">بانتظار المضيف يبدأ جولة جديدة…</p>'}</div>`;
}

// ---------- interaction ----------

function wire() {
  view.querySelectorAll("[data-k]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k, d = S.limits[k];
    net.send({ t: "settings", values: { [k]: S.settings[k] + d.step * Number(b.dataset.d) } });
    sfx.tap();
  }));
  view.querySelectorAll("[data-bots]").forEach((b) => b.addEventListener("click", () => {
    net.send({ t: "bots", n: S.players.filter((p) => p.bot).length + Number(b.dataset.bots) });
    sfx.tap();
  }));
  view.querySelectorAll("[data-flag]").forEach((b) => b.addEventListener("click", () => {
    net.send({ t: "settings", values: { [b.dataset.flag]: !S.settings[b.dataset.flag] } });
    sfx.tap();
  }));
  view.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
    picked = b.dataset.pick;
    net.send({ t: "pick", target: picked });
    sfx.pick();
    render();
  }));
  view.querySelectorAll("[data-vote]").forEach((b) => b.addEventListener("click", () => {
    picked = b.dataset.vote;
    net.send({ t: "vote", target: picked });
    sfx.pick();
    render();
  }));
  const act = (name, fn) => view.querySelector(`[data-act="${name}"]`)?.addEventListener("click", fn);
  act("start", () => net.send({ t: "start" }));
  act("again", () => net.send({ t: "again" }));
  act("ready", () => { net.send({ t: "ready", on: !me()?.ready }); sfx.tap(); });
  act("copy", copyLink);
  act("share", async () => {
    if (navigator.share) { try { await navigator.share({ title: "مافيا", text: `تعال العب مافيا معنا، رمز الغرفة ${S.code}`, url: link() }); } catch { /* cancelled */ } }
    else copyLink();
  });
  const card = $("roleCard");
  if (card) holdToShow(card, (on) => { card.classList.toggle("open", on); if (on) { buzz(25); net.send({ t: "seen" }); } });
}

/** Show while pressed, hide the moment the finger lifts. */
function holdToShow(el, set) {
  let on = false;
  const down = (e) => { e.preventDefault(); if (!on) { on = true; set(true); } };
  const up = () => { if (on) { on = false; set(false); } };
  el.addEventListener("pointerdown", down);
  for (const ev of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"]) el.addEventListener(ev, up);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

const link = () => `${location.origin}${location.pathname}?room=${S.code}${serverParam ? "&server=" + encodeURIComponent(serverParam) : ""}`;
async function copyLink() {
  try { await navigator.clipboard.writeText(link()); toast("انسخ الرابط. أرسله لربعك."); }
  catch { toast(link(), 6000); }
}

// The "my role" button in the top bar: hold to peek during the game.
holdToShow($("peekBtn"), (on) => {
  $("peekBtn").classList.toggle("showing", on);
  $("peekRole").textContent = on && S?.role ? ROLE[S.role].name + (S.alive ? "" : " (خارج)") : "دوري";
});

function mafiaChat() {
  const box = $("mchat");
  const show = S.phase === "night" && S.role === "mafia" && S.alive && (S.night?.mates?.length || 0) > 1;
  box.hidden = !show;
  document.body.classList.toggle("has-mchat", show);
  if (!show) return;
  const log = $("mchatLog");
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  log.innerHTML = (S.night.chat || []).map((c) => `<li><b>${esc(nameOf(c.from))}:</b> <bdi>${esc(c.text)}</bdi></li>`).join("") || '<li class="muted">شات سري بين المافيا بس. اتفقوا على الضحية.</li>';
  if (atEnd) log.scrollTop = log.scrollHeight;
}
$("mchatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("mchatIn").value.trim();
  if (!text || !net) return;
  net.send({ t: "mchat", text });
  $("mchatIn").value = "";
});

// ---------- timers, toasts, top bar ----------

let lastSecond = -1;
function tickTimers() {
  const t = view.querySelector("[data-timer]");
  if (!t || !S?.deadline) return;
  const total = { reveal: 25000, night: S.settings.night * 1000, discuss: S.settings.discuss * 1000, vote: S.settings.vote * 1000 }[S.phase] || 1;
  const left = remaining();
  const sec = Math.ceil(left / 1000);
  t.style.setProperty("--p", Math.max(0, Math.min(1, left / total)));
  t.classList.toggle("late", sec <= 10);
  t.querySelector("b").textContent = ar(sec);
  if (sec !== lastSecond && sec <= 5 && sec > 0 && ["night", "vote", "discuss"].includes(S.phase)) sfx.tick();
  lastSecond = sec;
}
setInterval(tickTimers, 250);

let toastTimer;
function toast(text, ms = 2600) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), ms);
}

function ask(title, text, yes, onYes) {
  $("askTitle").textContent = title;
  $("askText").textContent = text;
  $("askYes").textContent = yes;
  $("ask").hidden = false;
  $("askYes").onclick = () => { $("ask").hidden = true; onYes(); };
  $("askNo").onclick = () => { $("ask").hidden = true; };
}

const soundIcon = () => sfx.isMuted()
  ? '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m17 9 5 6m0-6-5 6"/></svg>'
  : '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
$("soundBtn").innerHTML = soundIcon();
$("soundBtn").addEventListener("click", () => { sfx.toggle(); $("soundBtn").innerHTML = soundIcon(); });
$("leaveBtn").addEventListener("click", () => {
  const inGame = S && !["lobby", "end"].includes(S.phase);
  ask("تطلع من الغرفة؟", inGame ? "بتطلع من الجولة وما تقدر ترجع لها." : "تقدر تدخل مرة ثانية بنفس الرمز.", "اطلع", () => {
    leaveRoom(true);
    setURL("");
    home();
  });
});

// Back from the background (phone locked, another app): check the link straight away.
const wake = () => { if (!document.hidden) net?.wake(); };
document.addEventListener("visibilitychange", wake);
addEventListener("pageshow", wake);
// iPhone Safari ignores user-scalable=no: stop pinch zoom from breaking the layout.
for (const ev of ["gesturestart", "gesturechange"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

// ---------- start ----------

const startCode = normalizeCode(new URLSearchParams(location.search).get("room"));
if (isValidCode(startCode) && store.get("mafia-token-" + startCode) && store.get("mafia-name")) enterRoom(startCode, false);
else home();
