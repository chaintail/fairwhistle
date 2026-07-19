/**
 * Anchor the agent's alert fingerprints on Solana devnet.
 *
 * Each planted-scenario detection has a cycle-invariant core fingerprint
 * (sha256 of the canonical detection core). This script writes each
 * fingerprint into a devnet memo transaction so anyone can independently
 * confirm the detection existed at anchor time. Output → data/anchors.json.
 *
 * Devnet only, honestly labeled. If devnet is unreachable/rate-limited the
 * script records status "simulated" rather than faking a transaction.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { ALL_ALERTS, FIXTURE_ID } from "../src/state.js";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RPC = process.env.SOLANA_DEVNET_RPC ?? "https://api.devnet.solana.com";

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const records: unknown[] = [];
  // Payer: explicit keypair path → default solana CLI keypair → ephemeral+airdrop.
  let payer: Keypair | null = null;
  const kpPath = process.env.SOLANA_PAYER_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");
  if (existsSync(kpPath)) {
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kpPath, "utf8"))));
    const bal = await conn.getBalance(payer.publicKey);
    console.log(`payer ${payer.publicKey.toBase58()} balance ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    if (bal < 0.001 * LAMPORTS_PER_SOL) payer = null;
  }
  let funded = payer !== null;
  if (!payer) {
    payer = Keypair.generate();
    try {
      console.log(`airdropping to ephemeral payer ${payer.publicKey.toBase58()}…`);
      const sig = await conn.requestAirdrop(payer.publicKey, 0.05 * LAMPORTS_PER_SOL);
      const bh = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      funded = true;
      console.log("airdrop confirmed");
    } catch (e) {
      console.error(`airdrop failed (${e instanceof Error ? e.message : e}) — recording simulated anchors`);
    }
  }

  for (const a of ALL_ALERTS) {
    const memo = `fairwhistle:v1:${FIXTURE_ID}:${a.core.rule}:${a.coreHash}`;
    if (!funded) {
      records.push({
        coreHash: a.coreHash,
        status: "simulated",
        note: "devnet airdrop unavailable at anchor time — memo payload preserved for re-anchoring",
        memo,
      });
      continue;
    }
    try {
      const tx = new Transaction().add(
        new TransactionInstruction({
          programId: MEMO_PROGRAM,
          keys: [],
          data: Buffer.from(memo, "utf8"),
        }),
      );
      const txSig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
      console.log(`anchored ${a.core.rule}: ${txSig}`);
      records.push({
        coreHash: a.coreHash,
        status: "anchored",
        cluster: "devnet",
        txSignature: txSig,
        explorerUrl: `https://explorer.solana.com/tx/${txSig}?cluster=devnet`,
        anchoredAt: new Date().toISOString(),
        memo,
      });
    } catch (e) {
      console.error(`anchor failed for ${a.core.rule}: ${e instanceof Error ? e.message : e}`);
      records.push({ coreHash: a.coreHash, status: "simulated", note: "devnet send failed at anchor time", memo });
    }
  }

  writeFileSync("data/anchors.json", JSON.stringify(records, null, 2));
  console.log(`wrote data/anchors.json (${records.length} records)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
