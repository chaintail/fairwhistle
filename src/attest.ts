/**
 * Alert attestation: canonical JSON → SHA-256 → Ed25519 signature.
 *
 * Two layers, deliberately split:
 *  - CORE (cycle-invariant): the detection fingerprint — rule, books,
 *    markets, tick offsets, z-scores, evidence hash. Identical every cycle,
 *    which is what makes it anchorable on-chain once and re-verifiable
 *    forever.
 *  - INSTANCE (per replay cycle): core hash + cycle + wall-clock detection
 *    time, signed live by the agent's Ed25519 key on every cycle.
 *
 * Signing uses the runtime's native Ed25519 (node:crypto). The private key
 * comes from the FAIRWHISTLE_SIGNING_KEY env var (base64 PKCS8); if absent
 * (fresh clone, no setup) an ephemeral per-instance key is generated and the
 * UI labels it as such — never a fake signature.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

/** Deterministic canonical JSON: recursively sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(",");
  return `{${body}}`;
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export interface AgentKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Raw 32-byte Ed25519 public key, hex — what verifiers use. */
  publicKeyHex: string;
  /** true if generated at cold start because no env key was configured. */
  ephemeral: boolean;
}

let cachedKey: AgentKey | null = null;

export function agentKey(): AgentKey {
  if (cachedKey) return cachedKey;
  const b64 = process.env.FAIRWHISTLE_SIGNING_KEY;
  let privateKey: KeyObject;
  let ephemeral = false;
  if (b64) {
    privateKey = createPrivateKey({
      key: Buffer.from(b64, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } else {
    privateKey = generateKeyPairSync("ed25519").privateKey;
    ephemeral = true;
  }
  const publicKey = createPublicKey(privateKey);
  // SPKI DER for Ed25519 = 12-byte header + 32-byte raw key.
  const spki = publicKey.export({ format: "der", type: "spki" });
  const publicKeyHex = Buffer.from(spki.subarray(spki.length - 32)).toString("hex");
  cachedKey = { privateKey, publicKey, publicKeyHex, ephemeral };
  return cachedKey;
}

export function signHex(message: string): string {
  return edSign(null, Buffer.from(message, "utf8"), agentKey().privateKey).toString("hex");
}

export function verifyHex(message: string, signatureHex: string, publicKeyHex: string): boolean {
  // Rebuild SPKI DER from the raw key: fixed Ed25519 SPKI prefix + raw bytes.
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const spki = Buffer.concat([prefix, Buffer.from(publicKeyHex, "hex")]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
}
