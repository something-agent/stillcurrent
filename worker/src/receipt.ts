/**
 * POST /verify/payment: did a claimed USDC payment on Base really settle, to the right address, for the right amount?
 *
 * Reads the chain through public JSON-RPC (no API key, no indexer): the transaction receipt, the transaction, the
 * block timestamp, the head and the finalized block. Decodes the native-USDC Transfer logs and the EIP-3009
 * AuthorizationUsed log (what an x402 "exact" payment leaves behind), and compares them with the caller's claim.
 * A second, independent RPC is asked for the same receipt as a cross-check (a witness, not a proof).
 *
 * Budget on Workers Free (50 subrequests, 10 ms CPU): normally 3 RPC subrequests (receipt+tx, block+head+finalized,
 * second-witness receipt); fallbacks add at most 4 more. No loops over logs beyond the receipt itself.
 * What this CANNOT tell you: who controls an address, whether the service was delivered, where the payer's funds came from.
 */
import type { Settings } from "./config";

export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const BASE_NETWORK = "eip155:8453";
export const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TOPIC_AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5"; // AuthorizationUsed(address,bytes32)
export const MAX_TRANSFERS_LISTED = 25;
const RPC_TIMEOUT_MS = 6000;

export type PaymentVerdict = "match" | "mismatch" | "not_settled" | "not_found" | "no_usdc_transfer" | "unconfirmed";

export interface PaymentRequest {
  tx_hash: string;
  claimed_payer: string | null; // only set when the caller sent a PAYMENT-RESPONSE header that names a payer
  expect: {
    payee: string | null; payer: string | null; amount_atomic: bigint | null; amount_match: "exact" | "at_least";
    min_confirmations: number | null; not_before: number | null; not_after: number | null; x402: boolean | null;
  };
  cross_check: boolean;
}

export class RpcUnavailable extends Error {}

type Rpc = { id: number; method: string; params: unknown[] };
type RpcOut = Record<number, { result?: any; error?: any }>;

const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };

async function rpcBatch(url: string, calls: Rpc[], f: typeof fetch): Promise<RpcOut> {
  const body = JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, method: c.method, params: c.params })));
  const r = await f(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "StillCurrent/0.4 (+https://github.com/something-agent/stillcurrent)" },
    body, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`rpc http ${r.status}`);
  const d: any = await r.json();
  const arr = Array.isArray(d) ? d : [d];
  const out: RpcOut = {};
  for (const x of arr) if (x && typeof x.id === "number") out[x.id] = x;
  for (const c of calls) {
    const x = out[c.id];
    if (!x) throw new Error("rpc batch incomplete");
    if (x.error) throw new Error(`rpc error ${x.error?.code ?? ""} on ${c.method}`);
  }
  return out;
}

/** Try each RPC in order until one answers the whole batch. Returns the answer and which RPC gave it. */
async function firstRpc(urls: string[], calls: Rpc[], f: typeof fetch, skip: Set<string> = new Set()): Promise<{ url: string; out: RpcOut } | null> {
  for (const u of urls) {
    if (skip.has(u)) continue;
    try { return { url: u, out: await rpcBatch(u, calls, f) }; } catch { /* next */ }
  }
  return null;
}

const hexToInt = (h: string): number => Number(BigInt(h));
const addrFromTopic = (t: string): string => ("0x" + t.slice(26)).toLowerCase();
const isHash = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);

export function formatUsdc(atomic: bigint): string {
  const neg = atomic < 0n; const a = neg ? -atomic : atomic;
  const whole = a / 1_000_000n; let frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Transfer { log_index: number; from: string; to: string; amount_atomic: string; amount_usdc: string }
interface Check { check: string; expected: unknown; actual: unknown; pass: boolean }

export async function verifyPayment(req: PaymentRequest, s: Settings, f: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const rpcs = s.rpcUrls;
  const limits = [
    "Reads Base mainnet state through public RPC nodes. A match means the chain shows a USDC Transfer with those fields in a successful transaction; it does not show who controls either address, that goods or services were delivered, or where the payer's funds came from.",
    "Only native USDC on Base (0x8335...2913) is checked. Other tokens and other chains are not.",
  ];
  const caveats: string[] = [];
  const evidenceRpc: string[] = [];

  // Round 1: receipt + transaction.
  const r1 = await firstRpc(rpcs, [
    { id: 1, method: "eth_getTransactionReceipt", params: [req.tx_hash] },
    { id: 2, method: "eth_getTransactionByHash", params: [req.tx_hash] },
  ], f);
  if (!r1) throw new RpcUnavailable("no RPC node answered");
  let primary = r1.url; let receipt = r1.out[1].result; let tx = r1.out[2].result;
  if (!receipt) {
    // Not on the first node that answered: ask the others before saying not_found (nodes lag each other by a block or two).
    const more = await firstRpc(rpcs, [{ id: 1, method: "eth_getTransactionReceipt", params: [req.tx_hash] }, { id: 2, method: "eth_getTransactionByHash", params: [req.tx_hash] }], f, new Set([primary]));
    if (more && more.out[1].result) { primary = more.url; receipt = more.out[1].result; tx = more.out[2].result; }
  }
  evidenceRpc.push("eth_getTransactionReceipt", "eth_getTransactionByHash");
  const base = { network: BASE_NETWORK, asset: "USDC", asset_address: USDC_BASE, tx_hash: req.tx_hash.toLowerCase() };
  const finishTime = () => ({ checked_at: new Date().toISOString(), took_ms: Date.now() - t0 });

  if (!receipt) {
    return {
      ...base, verdict: "not_found" satisfies PaymentVerdict, settled: false, matched: false,
      explanation: "No queried Base RPC node has a receipt for this hash. It may be pending, on another chain, mistyped, or never sent. This is absence of evidence from these nodes at this moment, not proof the payment was never made.",
      transfers: [], checks: [], rpc: { primary: hostOf(primary), witnesses: [hostOf(primary)] }, caveats: ["Re-check later if the transaction was sent in the last few seconds."], limits, ...finishTime(),
    };
  }

  // Round 2: block time, head, finalized block.
  const bn = receipt.blockNumber as string;
  const r2 = await firstRpc([primary, ...rpcs.filter((u) => u !== primary)], [
    { id: 1, method: "eth_getBlockByNumber", params: [bn, false] },
    { id: 2, method: "eth_blockNumber", params: [] },
    { id: 3, method: "eth_getBlockByNumber", params: ["finalized", false] },
  ], f);
  evidenceRpc.push("eth_getBlockByNumber", "eth_blockNumber");
  const blockNumber = hexToInt(bn);
  const blockTime: number | null = r2?.out[1].result?.timestamp ? hexToInt(r2.out[1].result.timestamp) : null;
  const head: number | null = r2?.out[2].result ? hexToInt(r2.out[2].result) : null;
  const finalized: number | null = r2?.out[3].result?.number ? hexToInt(r2.out[3].result.number) : null;
  if (!r2) caveats.push("Block time and confirmations could not be read from any node; time and confirmation checks are unevaluated.");
  const confirmations = head !== null ? Math.max(0, head - blockNumber + 1) : null;
  const isFinalized = finalized !== null ? blockNumber <= finalized : null;
  if (isFinalized === false) caveats.push("The block is not yet L1-finalized on Base; a reorg is very unlikely but not impossible. Use min_confirmations or re-check later for high-value payments.");

  // Decode logs.
  const reverted = receipt.status !== "0x1";
  const logs: any[] = Array.isArray(receipt.logs) ? receipt.logs : [];
  const transfers: Transfer[] = []; let transfersTotal = 0;
  const authLogs: { authorizer: string; nonce: string }[] = [];
  const raw: bigint[] = []; const rows: Transfer[] = [];
  for (const l of logs) {
    if (String(l.address).toLowerCase() !== USDC_BASE || !Array.isArray(l.topics)) continue;
    if (l.topics[0] === TOPIC_TRANSFER && l.topics.length === 3) {
      transfersTotal++;
      const amt = BigInt(l.data && l.data !== "0x" ? l.data : "0x0");
      const row = { log_index: hexToInt(l.logIndex), from: addrFromTopic(l.topics[1]), to: addrFromTopic(l.topics[2]), amount_atomic: amt.toString(), amount_usdc: formatUsdc(amt) };
      rows.push(row); raw.push(amt);
      if (transfers.length < MAX_TRANSFERS_LISTED) transfers.push(row);
    } else if (l.topics[0] === TOPIC_AUTH_USED && l.topics.length === 3) {
      authLogs.push({ authorizer: addrFromTopic(l.topics[1]), nonce: l.topics[2] });
    }
  }

  // Compare with the claim.
  const e = req.expect;
  const matches = (t: Transfer, amt: bigint): boolean =>
    (e.payee === null || t.to === e.payee) && (e.payer === null || t.from === e.payer) &&
    (e.amount_atomic === null || (e.amount_match === "exact" ? amt === e.amount_atomic : amt >= e.amount_atomic));
  const matchedIdx = rows.map((t, i) => (matches(t, raw[i]) ? i : -1)).filter((i) => i >= 0);
  const matched = matchedIdx.length ? rows[matchedIdx[0]] : null;
  const anyTo = e.payee !== null ? rows.find((t) => t.to === e.payee) ?? null : null;
  const focus = matched ?? anyTo ?? rows[0] ?? null; // transfer shown as "actual" in the checks

  const checks: Check[] = [];
  checks.push({ check: "tx_succeeded", expected: "success", actual: reverted ? "reverted" : "success", pass: !reverted });
  if (e.payee !== null) checks.push({ check: "payee_received_usdc", expected: e.payee, actual: rows.filter((t) => t.to === e.payee).length ? e.payee : (focus?.to ?? null), pass: rows.some((t) => t.to === e.payee) });
  if (e.payer !== null) checks.push({ check: "payer_sent_usdc", expected: e.payer, actual: rows.some((t) => t.from === e.payer) ? e.payer : (focus?.from ?? null), pass: rows.some((t) => t.from === e.payer) });
  if (e.amount_atomic !== null) {
    const cand = matched ?? anyTo ?? focus;
    const candAmt = cand ? BigInt(cand.amount_atomic) : null;
    const ok = rows.some((t, i) => (e.payee === null || t.to === e.payee) && (e.amount_match === "exact" ? raw[i] === e.amount_atomic : raw[i] >= e.amount_atomic!));
    checks.push({ check: e.amount_match === "exact" ? "amount_exact" : "amount_at_least", expected: formatUsdc(e.amount_atomic), actual: candAmt === null ? null : formatUsdc(candAmt), pass: ok });
  }
  const fieldCount = [e.payee, e.payer, e.amount_atomic].filter((x) => x !== null).length;
  if (fieldCount >= 2) checks.push({ check: "one_transfer_matches_all_fields", expected: "a single Transfer log satisfying every field", actual: matched ? `log ${matched.log_index}` : "none", pass: matched !== null });
  if (e.min_confirmations !== null) checks.push({ check: "min_confirmations", expected: e.min_confirmations, actual: confirmations, pass: confirmations !== null && confirmations >= e.min_confirmations });
  if (e.not_before !== null) checks.push({ check: "not_before", expected: new Date(e.not_before * 1000).toISOString(), actual: blockTime === null ? null : new Date(blockTime * 1000).toISOString(), pass: blockTime !== null && blockTime >= e.not_before });
  if (e.not_after !== null) checks.push({ check: "not_after", expected: new Date(e.not_after * 1000).toISOString(), actual: blockTime === null ? null : new Date(blockTime * 1000).toISOString(), pass: blockTime !== null && blockTime <= e.not_after });

  // x402 / EIP-3009 pattern: a USDC AuthorizationUsed log whose authorizer is the sender of the matched (or focus) transfer.
  const payTransfer = matched ?? focus;
  const authFor = payTransfer ? authLogs.find((a) => a.authorizer === payTransfer.from) ?? null : null;
  const txTo = typeof tx?.to === "string" ? tx.to.toLowerCase() : null;
  const x402 = {
    eip3009_authorization_used: authFor !== null, authorizer: authFor?.authorizer ?? null, nonce: authFor?.nonce ?? null,
    submitted_by: typeof tx?.from === "string" ? tx.from.toLowerCase() : null,
    submitted_to_usdc_contract: txTo === null ? null : txTo === USDC_BASE,
    pattern: authFor === null ? "none" : txTo === USDC_BASE ? "x402_exact_direct" : "eip3009_via_other_contract",
    note: "x402 'exact' payments are EIP-3009 authorizations: the payer signs, a facilitator submits and pays gas (often through a Multicall3 contract), so submitted_by is usually the facilitator, not the payer. The pattern shows an EIP-3009 authorization was consumed for that sender; it does not by itself prove the payment was made through x402.",
  };
  if (e.x402 !== null) checks.push({ check: "x402_exact_pattern", expected: e.x402, actual: authFor !== null, pass: (authFor !== null) === e.x402 });
  if (req.claimed_payer !== null) {
    const ok = rows.some((t) => t.from === req.claimed_payer);
    checks.push({ check: "payer_named_in_payment_response", expected: req.claimed_payer, actual: ok ? req.claimed_payer : (focus?.from ?? null), pass: ok });
  }

  const counterparty = payTransfer ? {
    payer: payTransfer.from, payee: payTransfer.to, self_payment: payTransfer.from === payTransfer.to,
    note: "self_payment=true means payer and payee are the same address: the transfer is real but is not outside demand. Whether the payer is related to the payee in any other way (funded by, same operator) is NOT assessed.",
  } : null;

  // Second witness: another RPC node, same receipt.
  let rpcInfo: Record<string, unknown> = { primary: hostOf(primary), witnesses: [hostOf(primary)], independent_rpc_agrees: null };
  let witnessDisagrees = false;
  if (req.cross_check) {
    const w = await firstRpc(rpcs, [{ id: 1, method: "eth_getTransactionReceipt", params: [req.tx_hash] }], f, new Set([primary]));
    if (w) {
      const wr = w.out[1].result;
      const agrees = !!wr && wr.status === receipt.status && String(wr.blockHash).toLowerCase() === String(receipt.blockHash).toLowerCase() && Array.isArray(wr.logs) && wr.logs.length === logs.length;
      rpcInfo = { primary: hostOf(primary), witnesses: [hostOf(primary), hostOf(w.url)], independent_rpc_agrees: agrees };
      if (!agrees) {
        witnessDisagrees = true;
        caveats.push(wr ? "A second RPC node returned a different receipt (status, block hash or log count): possible reorg or node fault, so the verdict is 'unconfirmed' and primary_verdict shows what the first node alone implied. Re-check in a minute." : "A second RPC node does not have this receipt yet (node lag or reorg), so the verdict is 'unconfirmed' and primary_verdict shows what the first node alone implied. Re-check in a minute.");
      }
    } else caveats.push("No second RPC node answered, so this verdict has a single witness.");
  }

  const primaryVerdict: PaymentVerdict = reverted ? "not_settled" : rows.length === 0 ? "no_usdc_transfer" : checks.every((c) => c.pass) ? "match" : "mismatch";
  // Two witnesses that disagree (block hash, status, log count, or one lacks the receipt) never yield a confident verdict.
  const verdict: PaymentVerdict = witnessDisagrees ? "unconfirmed" : primaryVerdict;
  const failed = checks.filter((c) => !c.pass).map((c) => c.check);
  const explanation = verdict === "unconfirmed"
    ? `Unconfirmed: the first RPC node implies '${primaryVerdict}', but a second independent node returned a different receipt or none (possible reorg or node lag). Do not rely on either reading yet; re-check shortly.`
    : verdict === "match"
    ? `Settled: the transaction succeeded and the chain shows a USDC Transfer of ${matched ? matched.amount_usdc : "?"} from ${matched?.from} to ${matched?.to} that satisfies every field you supplied.`
    : verdict === "not_settled" ? "The transaction was mined but reverted, so no USDC moved."
    : verdict === "no_usdc_transfer" ? "The transaction succeeded but emitted no native-USDC Transfer on Base, so it is not a USDC payment (it may be another token, a native ETH transfer, or another chain)."
    : `The transaction is real but does not match your claim: failed checks: ${failed.join(", ")}.`;

  const receiptCanon = JSON.stringify({ transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, status: receipt.status,
    logs: logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })) });

  return {
    ...base, verdict, primary_verdict: primaryVerdict, settled: !witnessDisagrees && !reverted && rows.length > 0, matched: verdict === "match", explanation,
    matched_transfer: matched, matching_transfers: matchedIdx.length,
    transfers, transfers_total: transfersTotal, ...(transfersTotal > transfers.length ? { transfers_truncated: true } : {}),
    checks,
    finality: { block_number: blockNumber, block_hash: receipt.blockHash, block_time: blockTime === null ? null : new Date(blockTime * 1000).toISOString(),
      confirmations, finalized_block: finalized, is_l1_finalized: isFinalized },
    x402, counterparty, rpc: rpcInfo,
    evidence: { receipt_sha256: await sha256Hex(receiptCanon), rpc_methods: [...new Set(evidenceRpc)],
      reproduce: `eth_getTransactionReceipt(${req.tx_hash.toLowerCase()}) on any Base mainnet RPC; decode logs from ${USDC_BASE}: Transfer topic ${TOPIC_TRANSFER}, AuthorizationUsed topic ${TOPIC_AUTH_USED}.` },
    caveats, limits, ...finishTime(),
  };
}

export { isHash };
