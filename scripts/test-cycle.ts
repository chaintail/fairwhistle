/**
 * Deterministic cycle test: run the detectors over the full tape and assert
 * the agent catches exactly the three planted scenarios — and nothing else.
 * Exits non-zero on any mismatch; run before every deploy.
 */

import { SCENARIOS } from "../src/fixture.js";
import { ALL_ALERTS, FIXTURE_ID } from "../src/state.js";
import { canonicalJson, sha256Hex, signHex, verifyHex, agentKey } from "../src/attest.js";

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  ✗ ${msg}`);
};
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

console.log(`FairWhistle cycle test — fixture ${FIXTURE_ID}`);
console.log(`\nAlerts detected: ${ALL_ALERTS.length}`);
for (const a of ALL_ALERTS) {
  console.log(
    `  [${a.core.rule}] t=${a.core.tDetect} z=${a.core.zPeak} books=${a.core.books.join(",")} oc=${a.core.outcomes.join(",")} :: ${a.core.headline}`,
  );
}

console.log("\nAssertions:");
if (ALL_ALERTS.length === SCENARIOS.length) ok(`exactly ${SCENARIOS.length} alerts`);
else fail(`expected ${SCENARIOS.length} alerts, got ${ALL_ALERTS.length}`);

for (const s of SCENARIOS) {
  const hit = ALL_ALERTS.find(
    (a) => a.core.rule === s.rule && a.core.tDetect >= s.window[0] && a.core.tDetect <= s.window[1] + 15,
  );
  if (hit) ok(`${s.id} caught by ${s.rule} at t=${hit.core.tDetect}`);
  else fail(`${s.id} NOT caught (rule=${s.rule}, window=${s.window.join("-")})`);
}

for (const a of ALL_ALERTS) {
  const inSomeWindow = SCENARIOS.some(
    (s) => a.core.tDetect >= s.window[0] - 5 && a.core.tDetect <= s.window[1] + 15,
  );
  if (!inSomeWindow) fail(`false positive: ${a.core.rule} at t=${a.core.tDetect}`);
}
ok("no alerts outside planted windows (if no ✗ above)");

// Attestation round-trip.
const key = agentKey();
const msg = canonicalJson({ probe: "fairwhistle", hash: sha256Hex("x") });
const sig = signHex(msg);
if (verifyHex(msg, sig, key.publicKeyHex)) ok("ed25519 sign/verify round-trip");
else fail("ed25519 round-trip failed");
if (verifyHex(msg + " ", sig, key.publicKeyHex)) fail("tampered message verified!");
else ok("tampered message rejected");

// Determinism: hashes stable across a re-run of the whole pipeline.
console.log(`\nCore hashes (anchor targets):`);
for (const a of ALL_ALERTS) console.log(`  ${a.core.rule}: ${a.coreHash}`);

process.exit(failures ? 1 : 0);
