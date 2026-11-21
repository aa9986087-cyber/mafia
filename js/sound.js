// Light sound effects made in the browser (no files), a mute switch that is remembered, and short vibrations.
let ctx = null;
let muted = false;
try { muted = localStorage.getItem("mafia-muted") === "1"; } catch { /* storage blocked */ }

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  return ctx;
}
const wake = () => { if (ctx && ctx.state !== "running" && !document.hidden) ctx.resume().catch(() => {}); };
addEventListener("pointerdown", wake, { passive: true });
document.addEventListener("visibilitychange", wake);

function tone(freq, dur, { type = "sine", vol = 0.12, at = 0, slide = 0 } = {}) {
  if (muted) return;
  try {
    const a = ac(), t = a.currentTime + at;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t); o.stop(t + dur + 0.05);
  } catch { /* no audio */ }
}

export const buzz = (pattern) => { try { if (!muted) navigator.vibrate?.(pattern); } catch { /* not supported (iPhone) */ } };

export const sfx = {
  unlock() { try { ac(); } catch { /* no audio */ } },
  isMuted: () => muted,
  toggle() { muted = !muted; try { localStorage.setItem("mafia-muted", muted ? "1" : "0"); } catch { /* fine */ } return muted; },
  tap() { tone(520, 0.06, { type: "triangle", vol: 0.07 }); },
  pick() { tone(440, 0.08, { type: "triangle" }); tone(660, 0.12, { type: "triangle", at: 0.07 }); },
  join() { tone(392, 0.1, { type: "triangle" }); tone(523, 0.14, { type: "triangle", at: 0.09 }); },
  night() { tone(196, 0.9, { vol: 0.1, slide: -60 }); tone(147, 1.2, { vol: 0.08, at: 0.25, slide: -40 }); buzz(60); },
  morning() { tone(523, 0.2, { type: "triangle" }); tone(659, 0.2, { type: "triangle", at: 0.15 }); tone(784, 0.35, { type: "triangle", at: 0.3 }); },
  death() { tone(220, 0.5, { type: "sawtooth", vol: 0.08, slide: -140 }); buzz([120, 80, 220]); },
  saved() { tone(587, 0.18, { type: "triangle" }); tone(880, 0.35, { type: "triangle", at: 0.14 }); buzz(40); },
  vote() { tone(330, 0.12, { type: "square", vol: 0.05 }); buzz(30); },
  tick() { tone(1000, 0.04, { type: "square", vol: 0.03 }); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { type: "triangle", at: i * 0.12 })); buzz([60, 40, 60]); },
  lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.4, { type: "sawtooth", vol: 0.07, at: i * 0.18 })); }
};
