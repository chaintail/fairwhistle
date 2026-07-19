/**
 * Generate the agent's Ed25519 signing keypair.
 * Prints the base64 PKCS8 private key (→ FAIRWHISTLE_SIGNING_KEY env var,
 * never committed) and the raw hex public key (published, verifies alerts).
 */
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const spki = publicKey.export({ format: "der", type: "spki" });
const pubHex = Buffer.from(spki.subarray(spki.length - 32)).toString("hex");

console.log("FAIRWHISTLE_SIGNING_KEY (secret — env var only):");
console.log(pkcs8);
console.log("\nAgent public key (hex, publish freely):");
console.log(pubHex);
