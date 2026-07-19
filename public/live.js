/* FairWhistle LIVE — real-fixture surveillance view. */
"use strict";

const OC_META = {
  h: { label: "Spain (home)", color: "#3987e5" },
  d: { label: "Draw", color: "#898781" },
  a: { label: "Argentina (away)", color: "#d55181" },
  o: { label: "Over 2.5", color: "#c98500" },
  u: { label: "Under 2.5", color: "#199e70" },
};
const W = 720, H = 190, PAD = { l: 46, r: 12, t: 10, b: 22 };

const S = { data: null, rangeMs: 6 * 3600_000 };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function poll() {
  try {
    const r = await fetch("/api/live-state");
    if (!r.ok) { $("feed-status").textContent = "feed: unavailable (no credentials?)"; return; }
    S.data = await r.json();
    render();
  } catch {
    $("feed-status").textContent = "feed: retrying…";
  }
}

function render() {
  const d = S.data;
  if (!d || !d.points || !d.points.length) return;
  $("pubkey").textContent = d.agentPubKey.slice(0, 16) + "…";
  $("pubkey").title = d.agentPubKey;
  $("fixture-label").textContent = d.label;
  $("badge-state").textContent = `state: ${d.gameState ?? "unknown"}`;
  $("honesty-note").textContent = d.honesty;
  const last = d.points[d.points.length - 1];
  $("feed-status").textContent = `feed: live · last update ${new Date(last.ts).toISOString().slice(11, 19)}Z · ${d.points.length} pts (48h)`;
  if (d.startTime) {
    const dt = d.startTime - Date.now();
    $("kickoff").textContent = dt > 0
      ? `kickoff in ${Math.floor(dt / 3600_000)}h ${Math.floor((dt % 3600_000) / 60_000)}m (${new Date(d.startTime).toISOString().slice(11, 16)}Z)`
      : `kicked off ${new Date(d.startTime).toISOString().slice(11, 16)}Z`;
  }
  const evs = d.events.filter((e) => e.kind !== "news_reprice");
  if (evs.length) {
    const e = evs[evs.length - 1];
    $("last-event").textContent = `last feed event: ${e.kind} · ${new Date(e.ts).toISOString().slice(11, 19)}Z`;
  }
  drawChart("chart-1x2", "legend-1x2", ["h", "d", "a"], "1X2 · full time");
  drawChart("chart-ou", "legend-ou", ["o", "u"], "Totals · Over/Under 2.5");
  renderAlerts();
}

function drawChart(el, legendEl, ocs, title) {
  const d = S.data;
  const tMax = d.points[d.points.length - 1].ts;
  const tMin = tMax - S.rangeMs;
  const pts = d.points.filter((p) => p.ts >= tMin);
  if (pts.length < 2) return;
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) for (const oc of ocs) { const v = p.odds[oc]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const padY = (hi - lo) * 0.1 + 0.02; lo -= padY; hi += padY;
  const x = (ts) => PAD.l + ((ts - tMin) / (tMax - tMin)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const parts = [];
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    parts.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}" stroke="#2c2c2a"/>`);
    parts.push(`<text x="${PAD.l - 6}" y="${y(v) + 4}" fill="#898781" font-size="10" text-anchor="end">${v.toFixed(2)}</text>`);
  }
  for (let i = 0; i <= 5; i++) {
    const ts = tMin + ((tMax - tMin) * i) / 5;
    parts.push(`<text x="${x(ts)}" y="${H - 6}" fill="#898781" font-size="10" text-anchor="middle">${new Date(ts).toISOString().slice(11, 16)}Z</text>`);
  }
  for (const e of S.data.events) {
    if (e.ts < tMin || e.ts > tMax) continue;
    parts.push(`<line x1="${x(e.ts)}" x2="${x(e.ts)}" y1="${PAD.t}" y2="${H - PAD.b}" stroke="#383835" stroke-width="1.5" stroke-dasharray="4 4"/>`);
  }
  for (const oc of ocs) {
    let dd = "", prevY = null;
    for (const p of pts) {
      const px = x(p.ts).toFixed(1), py = y(p.odds[oc]).toFixed(1);
      if (!dd) dd = `M${px},${py}`;
      else dd += `L${px},${prevY}L${px},${py}`; // step-after: hold until reprice
      prevY = py;
    }
    parts.push(`<path d="${dd}" fill="none" stroke="${OC_META[oc].color}" stroke-width="2" stroke-linejoin="round"/>`);
    const lp = pts[pts.length - 1];
    parts.push(`<circle cx="${x(lp.ts)}" cy="${y(lp.odds[oc])}" r="3.5" fill="${OC_META[oc].color}" stroke="#1a1a19" stroke-width="2"/>`);
    parts.push(`<text x="${W - PAD.r - 4}" y="${y(lp.odds[oc]) - 6}" fill="${OC_META[oc].color}" font-size="10" text-anchor="end">${lp.odds[oc].toFixed(2)}</text>`);
  }
  for (const a of S.data.alerts) {
    if (!a.core.outcomes.some((o) => ocs.includes(o))) continue;
    if (a.core.tsDetect < tMin || a.core.tsDetect > tMax) continue;
    const col = a.severity === "critical" ? "#d03b3b" : "#ec835a";
    parts.push(`<path d="M${x(a.core.tsDetect)},${PAD.t + 2} l5,9 h-10 z" fill="${col}"/>`);
  }
  $(el).innerHTML = `<p class="chart-title">${esc(title)}</p><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><line x1="${PAD.l}" x2="${W - PAD.r}" y1="${H - PAD.b}" y2="${H - PAD.b}" stroke="#383835"/>${parts.join("")}</svg>`;
  $(legendEl).innerHTML = ocs
    .map((oc) => `<span class="key"><span class="swatch" style="background:${OC_META[oc].color}"></span>${esc(OC_META[oc].label)}</span>`)
    .join("");
}

function renderAlerts() {
  const list = [...S.data.alerts].sort((a, b) => b.core.tsDetect - a.core.tsDetect);
  if (!list.length) return;
  $("alerts").innerHTML = list
    .map((a) => `<div class="alert-card ${a.severity}">
      <div class="alert-head">
        <span class="sev ${a.severity}">${a.severity === "critical" ? "◆ CRITICAL" : "▲ HIGH"}</span>
        <span style="color:var(--ink-3);font-size:11.5px">${esc(a.core.rule)} · LIVE</span>
        <span class="alert-when">${esc(new Date(a.core.tsDetect).toISOString().replace("T", " ").slice(0, 19))}Z</span>
      </div>
      <h3>${esc(a.core.headline)}</h3>
      <p class="narrative">${esc(a.core.narrative)}</p>
      <div class="hashrow"><span class="label">fingerprint</span><code title="${esc(a.coreHash)}">${esc(a.coreHash)}</code></div>
      <div class="hashrow"><span class="label">signature</span><code title="${esc(a.signature)}">${esc(a.signature.slice(0, 32))}…</code></div>
      <div class="alert-actions">
        <button class="act" id="verify-${a.id}">Verify signature</button>
        <span id="verdict-${a.id}"></span>
      </div>
    </div>`)
    .join("");
  for (const a of list) $(`verify-${a.id}`).addEventListener("click", () => verifyAlert(a));
}

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

$("rng-6").addEventListener("click", () => { S.rangeMs = 6 * 3600_000; render(); });
$("rng-48").addEventListener("click", () => { S.rangeMs = 48 * 3600_000; render(); });

poll();
setInterval(poll, 20000);
