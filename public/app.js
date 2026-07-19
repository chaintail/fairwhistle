/* FairWhistle dashboard — polls the agent, renders the live tape + attested alerts. */
"use strict";

const BOOK_COLOR = {
  alpha: "#3987e5",
  borealis: "#008300",
  cirrus: "#d55181",
  dorado: "#c98500",
};
const CHARTS = [
  { el: "chart-h", oc: "h", title: "1X2 · Home win (FC Meridian)" },
  { el: "chart-a", oc: "a", title: "1X2 · Away win (Atlético Solara)" },
  { el: "chart-o", oc: "o", title: "Totals · Over 2.5 goals" },
];
const W = 720, H = 150, PAD = { l: 42, r: 10, t: 8, b: 20 };

const S = {
  meta: null,
  quotes: [], // quotes[t] = { bookId: {h,d,a,o,u} }
  events: [],
  alerts: new Map(), // id -> alert (current cycle)
  lastTick: -1,
  cycle: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- polling ----------
async function poll() {
  try {
    const r = await fetch(`/api/state?since=${S.lastTick}`);
    if (!r.ok) return;
    const st = await r.json();
    if (!S.meta) applyMeta(st.meta);
    if (S.cycle !== null && st.now.cycle !== S.cycle) {
      // new replay cycle — wipe the tape and start over
      S.quotes = [];
      S.alerts.clear();
      S.lastTick = -1;
      const r2 = await fetch(`/api/state?since=-1`);
      if (r2.ok) return applyState(await r2.json());
      return;
    }
    applyState(st);
  } catch { /* transient network — next poll retries */ }
}

function applyMeta(meta) {
  S.meta = meta;
  $("pubkey").textContent = meta.agentPubKey.slice(0, 16) + "…" + (meta.keyEphemeral ? " (ephemeral)" : "");
  $("pubkey").title = meta.agentPubKey;
  $("fixture-id").textContent = meta.fixtureId;
  $("synthetic-note").textContent = meta.syntheticNote;
  $("legend").innerHTML = meta.books
    .map((b) => `<span class="key"><span class="swatch" style="background:${BOOK_COLOR[b.id]}"></span>${esc(b.name)}</span>`)
    .join("");
  $("scenario-list").innerHTML = meta.scenarios
    .map((s) => `<li><strong>${esc(s.title)}</strong> <span style="color:var(--ink-3)">(planted, replay t=${s.window[0]}–${s.window[1]})</span> — ${esc(s.story)}</li>`)
    .join("");
}

function applyState(st) {
  S.cycle = st.now.cycle;
  for (const tk of st.ticks) S.quotes[tk.t] = tk.quotes;
  S.lastTick = st.now.tick;
  S.events = st.events;
  for (const a of st.alerts) if (!S.alerts.has(a.id)) { S.alerts.set(a.id, a); renderAlerts(); }
  renderScoreboard(st);
  for (const c of CHARTS) renderChart(c);
}

// ---------- scoreboard ----------
function renderScoreboard(st) {
  $("minute").textContent = `${st.now.matchMinute}'`;
  let h = 0, a = 0;
  const chips = [];
  for (const e of st.events) {
    if (!e.occurred) continue;
    if (e.type === "goal") { e.team === "home" ? h++ : a++; }
    chips.push(`<span class="event-chip ${e.type === "red_card" ? "red" : ""}">${e.type === "goal" ? "⚽" : "🟥"} ${esc(e.label)}</span>`);
  }
  $("score").textContent = `${h} – ${a}`;
  $("eventlog").innerHTML = chips.join("");
  $("badge-cycle").textContent = `cycle #${st.now.cycle}`;
  $("replay-pos").textContent = `replay t=${st.now.tick}/${S.meta.ticks} · 10-min loop · deterministic`;
  const nxt = S.meta.scenarios.find((s) => s.window[0] > st.now.tick);
  const active = S.meta.scenarios.find((s) => st.now.tick >= s.window[0] && st.now.tick <= s.window[1]);
  $("next-window").textContent = active
    ? `⚠ planted window ACTIVE: ${active.title}`
    : nxt
      ? `next planted window: ${nxt.title} in ${nxt.window[0] - st.now.tick}s`
      : "no more planted windows this cycle";
}

// ---------- charts ----------
function extent(oc) {
  let lo = Infinity, hi = -Infinity;
  for (const q of S.quotes) {
    if (!q) continue;
    for (const b in q) { const v = q[b][oc]; if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (!isFinite(lo)) { lo = 1; hi = 2; }
  const pad = (hi - lo) * 0.08 + 0.02;
  return [lo - pad, hi + pad];
}
const xOf = (t) => PAD.l + (t / 599) * (W - PAD.l - PAD.r);
function yOf(v, lo, hi) { return PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b); }

function renderChart({ el, oc, title }) {
  const [lo, hi] = extent(oc);
  const parts = [];
  // grid + y labels (4 ticks)
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    const y = yOf(v, lo, hi);
    parts.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" stroke="#2c2c2a" stroke-width="1"/>`);
    parts.push(`<text x="${PAD.l - 6}" y="${y + 4}" fill="#898781" font-size="10" text-anchor="end">${v.toFixed(2)}</text>`);
  }
  // x labels: match minutes
  for (const m of [0, 15, 30, 45, 60, 75]) {
    const x = xOf(Math.min(599, m * 8));
    parts.push(`<text x="${x}" y="${H - 5}" fill="#898781" font-size="10" text-anchor="middle">${m}'</text>`);
  }
  // event verticals
  for (const e of S.events) {
    if (!e.occurred) continue;
    const x = xOf(e.t);
    parts.push(`<line x1="${x}" x2="${x}" y1="${PAD.t}" y2="${H - PAD.b}" stroke="#383835" stroke-width="1.5" stroke-dasharray="4 4"/>`);
    parts.push(`<text x="${x + 3}" y="${PAD.t + 9}" fill="#898781" font-size="9">${e.type === "goal" ? "⚽" : "🟥"}</text>`);
  }
  // series
  for (const b of Object.keys(BOOK_COLOR)) {
    let d = "";
    for (let t = 0; t <= S.lastTick; t++) {
      const q = S.quotes[t];
      if (!q || !q[b]) continue;
      d += `${d ? "L" : "M"}${xOf(t).toFixed(1)},${yOf(q[b][oc], lo, hi).toFixed(1)}`;
    }
    if (d) parts.push(`<path d="${d}" fill="none" stroke="${BOOK_COLOR[b]}" stroke-width="2" stroke-linejoin="round"/>`);
    const last = S.quotes[S.lastTick];
    if (last && last[b]) {
      parts.push(`<circle cx="${xOf(S.lastTick)}" cy="${yOf(last[b][oc], lo, hi)}" r="3" fill="${BOOK_COLOR[b]}" stroke="#1a1a19" stroke-width="2"/>`);
    }
  }
  // alert markers
  for (const a of S.alerts.values()) {
    if (!a.core.outcomes.includes(oc)) continue;
    const x = xOf(a.core.tDetect);
    const col = a.severity === "critical" ? "#d03b3b" : "#ec835a";
    parts.push(`<path d="M${x},${PAD.t + 2} l5,9 h-10 z" fill="${col}"/>`);
    parts.push(`<line x1="${x}" x2="${x}" y1="${PAD.t + 11}" y2="${H - PAD.b}" stroke="${col}" stroke-width="1" stroke-dasharray="2 3" opacity="0.7"/>`);
  }
  parts.push(`<rect id="hover-${oc}" x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}" fill="transparent"/>`);
  $(el).innerHTML =
    `<p class="chart-title">${esc(title)}</p>` +
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)} odds by bookmaker">` +
    `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${H - PAD.b}" y2="${H - PAD.b}" stroke="#383835"/>` +
    parts.join("") +
    `</svg>`;
  const rect = $(`hover-${oc}`);
  rect.addEventListener("mousemove", (ev) => hover(ev, oc), { passive: true });
  rect.addEventListener("mouseleave", () => { $("tooltip").style.display = "none"; });
}

function hover(ev, oc) {
  const svg = ev.target.ownerSVGElement;
  const box = svg.getBoundingClientRect();
  const frac = (ev.clientX - box.left) / box.width;
  const t = Math.max(0, Math.min(S.lastTick, Math.round(((frac * W - PAD.l) / (W - PAD.l - PAD.r)) * 599)));
  const q = S.quotes[t];
  if (!q) return;
  const rows = S.meta.books
    .map((b) => `<div class="row"><span><span class="swatch" style="background:${BOOK_COLOR[b.id]};display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle"></span>${esc(b.name)}</span><span class="v">${q[b.id][oc].toFixed(2)}</span></div>`)
    .join("");
  const tt = $("tooltip");
  tt.innerHTML = `<div class="tt-t">${Math.floor(t / 8)}' · replay t=${t}</div>${rows}`;
  tt.style.display = "block";
  tt.style.left = Math.min(window.innerWidth - 190, ev.clientX + 14) + "px";
  tt.style.top = ev.clientY + 14 + "px";
}

// ---------- alerts ----------
function renderAlerts() {
  const list = [...S.alerts.values()].sort((x, y) => y.core.tDetect - x.core.tDetect);
  if (!list.length) return;
  $("alerts").innerHTML = list.map(alertCard).join("");
  for (const a of list) {
    $(`verify-${a.id}`).addEventListener("click", () => verifyAlert(a));
    $(`evtoggle-${a.id}`).addEventListener("click", () => toggleEvidence(a));
  }
}

function alertCard(a) {
  const minute = Math.floor(a.core.tDetect / 8);
  const anchor = a.anchor
    ? a.anchor.status === "anchored"
      ? `<span class="anchor-chip">⛓ fingerprint anchored · <a href="${esc(a.anchor.explorerUrl)}" target="_blank" rel="noopener">devnet tx ↗</a></span>`
      : `<span class="anchor-chip">⛓ anchor: simulated (labeled)</span>`
    : `<span class="anchor-chip">⛓ anchor: pending</span>`;
  return `<div class="alert-card ${a.severity}">
    <div class="alert-head">
      <span class="sev ${a.severity}">${a.severity === "critical" ? "◆ CRITICAL" : "▲ HIGH"}</span>
      <span style="color:var(--ink-3);font-size:11.5px">${esc(a.core.rule)}</span>
      <span class="alert-when">${minute}' · ${esc(a.instance.detectedAt.replace("T", " ").slice(0, 19))}Z</span>
    </div>
    <h3>${esc(a.core.headline)}</h3>
    <p class="narrative">${esc(a.core.narrative)}</p>
    <div class="hashrow"><span class="label">fingerprint</span><code title="${esc(a.coreHash)}">${esc(a.coreHash)}</code></div>
    <div class="hashrow"><span class="label">instance</span><code title="${esc(a.instanceHash)}">${esc(a.instanceHash)}</code></div>
    <div class="hashrow"><span class="label">signature</span><code title="${esc(a.signature)}">${esc(a.signature.slice(0, 32))}…</code></div>
    <div class="alert-actions">
      <button class="act" id="verify-${a.id}">Verify signature</button>
      <button class="act" id="evtoggle-${a.id}">Evidence</button>
      <span id="verdict-${a.id}"></span>
      ${anchor}
    </div>
    <div class="evidence" id="evidence-${a.id}" style="display:none"></div>
  </div>`;
}

// canonical JSON — must match src/attest.ts exactly
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}
const hexToBytes = (hex) => new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));

async function verifyAlert(a) {
  const out = $(`verdict-${a.id}`);
  out.className = "";
  out.textContent = "verifying…";
  const msg = canonicalJson(a.instance);
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(a.instance.agentPubKey), { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(a.signature), new TextEncoder().encode(msg));
    out.className = ok ? "verify-ok" : "verify-bad";
    out.textContent = ok ? "✓ valid — verified in your browser" : "✗ INVALID SIGNATURE";
  } catch {
    // Browser lacks WebCrypto Ed25519 — fall back to the API.
    try {
      const r = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance: a.instance, signature: a.signature, publicKey: a.instance.agentPubKey }),
      });
      const j = await r.json();
      out.className = j.valid ? "verify-ok" : "verify-bad";
      out.textContent = j.valid ? "✓ valid — server-verified" : "✗ INVALID SIGNATURE";
    } catch {
      out.textContent = "verification unavailable";
    }
  }
}

function toggleEvidence(a) {
  const el = $(`evidence-${a.id}`);
  if (el.style.display !== "none") { el.style.display = "none"; return; }
  el.style.display = "block";
  if (el.dataset.done) return;
  el.dataset.done = "1";
  el.innerHTML = `<p class="cap">Evidence window t=${a.evidence.window[0]}–${a.evidence.window[1]} · shaded = anomalous move · params: ${esc(Object.entries(a.evidence.params).map(([k, v]) => `${k}=${v}`).join(" · "))}</p>` + evidenceSvg(a);
}

function evidenceSvg(a) {
  const w = 368, h = 130, pad = { l: 36, r: 6, t: 6, b: 16 };
  const [t0, t1] = a.evidence.window;
  let lo = Infinity, hi = -Infinity;
  for (const s of a.evidence.series) for (const [, v] of s.points) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const yp = (hi - lo) * 0.08 + 0.01; lo -= yp; hi += yp;
  const x = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const parts = [];
  parts.push(`<rect x="${x(a.core.tStart)}" y="${pad.t}" width="${Math.max(2, x(a.core.tDetect) - x(a.core.tStart))}" height="${h - pad.t - pad.b}" fill="${a.severity === "critical" ? "#d03b3b" : "#ec835a"}" opacity="0.13"/>`);
  for (let i = 0; i <= 2; i++) {
    const v = lo + ((hi - lo) * i) / 2;
    parts.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#2c2c2a"/>`);
    parts.push(`<text x="${pad.l - 4}" y="${y(v) + 3.5}" fill="#898781" font-size="9" text-anchor="end">${v.toFixed(2)}</text>`);
  }
  const legend = [];
  a.evidence.series.forEach((s, i) => {
    const isCons = s.label.startsWith("Consensus");
    const bookId = Object.keys(BOOK_COLOR).find((b) => s.label.toLowerCase().startsWith(b.slice(0, 4))) ||
      (S.meta ? (S.meta.books.find((bk) => s.label.startsWith(bk.name)) || {}).id : null);
    const col = isCons ? "#898781" : BOOK_COLOR[bookId] || ["#3987e5", "#d55181", "#c98500", "#008300"][i % 4];
    let d = "";
    for (const [t, v] of s.points) d += `${d ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
    parts.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="1.8" ${isCons ? 'stroke-dasharray="4 3"' : ""}/>`);
    legend.push(`<span class="key"><span class="swatch" style="background:${col}"></span>${esc(s.label)}</span>`);
  });
  parts.push(`<text x="${x(a.core.tDetect)}" y="${h - 4}" fill="#898781" font-size="9" text-anchor="middle">detect t=${a.core.tDetect}</text>`);
  return `<svg viewBox="0 0 ${w} ${h}">${parts.join("")}</svg><div class="legend" style="font-size:11px">${legend.join("")}</div>`;
}

// ---------- boot ----------
poll();
setInterval(poll, 1000);
