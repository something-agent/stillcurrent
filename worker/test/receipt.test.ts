import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { formatUsdc, TOPIC_AUTH_USED, TOPIC_TRANSFER, USDC_BASE } from "../src/receipt";
import { parseUsdcAmount, validatePaymentVerify } from "../src/validate";
import { json, stubFetch } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x33190c9D2662F94A19CE88EA666f0ff8CeDe3700";
const FACIL = "0xb2bd29925cbbcea7628279c91945ca5b98bf371b";
const TX = "0x" + "ab".repeat(32);
const BLOCK_HASH = "0x" + "cd".repeat(32);
const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const amt = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

const VARS = { CONTACT_EMAIL: "t@example.com", X402_DISABLED: "1", PUBLIC_BASE_URL: "https://stillcurrent.test", RPC_URLS: "https://rpc-a.test,https://rpc-b.test,https://rpc-c.test" };
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let n = 0;
const post = (path: string, body: unknown, env: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://stillcurrent.test${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }),
    { ...VARS, ...env, BOT_CONTACT: `r${n++}` } as any, ctx);

function receipt(opts: { status?: string; logs?: any[]; blockHash?: string } = {}) {
  return {
    transactionHash: TX, blockHash: opts.blockHash ?? BLOCK_HASH, blockNumber: "0x3200000", status: opts.status ?? "0x1",
    logs: opts.logs ?? [
      { address: USDC_BASE, topics: [TOPIC_AUTH_USED, pad(PAYER), "0x" + "99".repeat(32)], data: "0x", logIndex: "0x1" },
      { address: USDC_BASE, topics: [TOPIC_TRANSFER, pad(PAYER), pad(PAYEE)], data: amt(20000n), logIndex: "0x2" },
    ],
  };
}
interface Node { receipt?: any | null; tx?: any; head?: string; fail?: boolean }
/** Fake JSON-RPC node that answers batches. */
const node = (host: string, cfg: Node) => (u: URL, init?: RequestInit) => {
  if (u.hostname !== host) return undefined;
  if (cfg.fail) return json({ error: "down" }, 500);
  const calls = JSON.parse(String(init?.body));
  return json(calls.map((c: any) => {
    let result: any = null;
    if (c.method === "eth_getTransactionReceipt") result = cfg.receipt ?? null;
    else if (c.method === "eth_getTransactionByHash") result = cfg.tx === undefined ? { from: FACIL, to: USDC_BASE } : cfg.tx;
    else if (c.method === "eth_blockNumber") result = cfg.head ?? "0x3200100";
    else if (c.method === "eth_getBlockByNumber") result = c.params[0] === "finalized" ? { number: "0x31fffff" } : { timestamp: "0x" + (1_790_000_000).toString(16), number: c.params[0] };
    return { jsonrpc: "2.0", id: c.id, result };
  }));
};
const good = { receipt: receipt() };

describe("validation (free 422 before any payment)", () => {
  it.each([
    ["not json", "{nope"],
    ["no tx and no expect", { foo: 1 }],
    ["bad hash", { tx_hash: "0x123", expect: { payee: PAYEE } }],
    ["no expect", { tx_hash: TX }],
    ["empty expect", { tx_hash: TX, expect: {} }],
    ["bad payee", { tx_hash: TX, expect: { payee: "0xabc" } }],
    ["too many decimals", { tx_hash: TX, expect: { amount_usdc: "0.0000001" } }],
    ["amounts disagree", { tx_hash: TX, expect: { amount_usdc: "0.02", amount_atomic: "20001" } }],
    ["other network", { tx_hash: TX, network: "eip155:1", expect: { payee: PAYEE } }],
    ["bad time", { tx_hash: TX, expect: { payee: PAYEE, not_before: "yesterday" } }],
    ["window reversed", { tx_hash: TX, expect: { payee: PAYEE, not_before: "2026-10-02T00:00:00Z", not_after: "2026-10-01T00:00:00Z" } }],
    ["extra field", { tx_hash: TX, expect: { payee: PAYEE }, wat: 1 }],
    ["garbage payment_response", { payment_response: "!!!", expect: { payee: PAYEE } }],
  ])("%s -> 422 charged:false", async (_n, body) => {
    const calls = stubFetch();
    const r = await post("/verify/payment", body);
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).charged).toBe(false);
    expect(calls).toEqual([]); // no RPC call happened either
  });
  it("amount parsing", () => {
    expect(parseUsdcAmount("0.02")).toBe(20000n);
    expect(parseUsdcAmount(1.5)).toBe(1_500_000n);
    expect(parseUsdcAmount("1e3")).toBeNull();
    expect(parseUsdcAmount("-1")).toBeNull();
    expect(formatUsdc(20000n)).toBe("0.02");
    expect(formatUsdc(100000n)).toBe("0.10");
    expect(formatUsdc(1_234_567n)).toBe("1.234567");
    expect(formatUsdc(5_000_000n)).toBe("5.00");
  });
  it("payment_response header supplies hash and payer; conflicting tx_hash rejected", () => {
    const hdr = btoa(JSON.stringify({ success: true, transaction: TX, network: "eip155:8453", payer: PAYER }));
    const v = validatePaymentVerify({ payment_response: hdr, expect: { payee: PAYEE } });
    expect(v.ok && v.value.tx_hash).toBe(TX);
    expect(v.ok && v.value.claimed_payer).toBe(PAYER);
    const bad = validatePaymentVerify({ tx_hash: "0x" + "11".repeat(32), payment_response: hdr, expect: { payee: PAYEE } });
    expect(bad.ok).toBe(false);
    expect(validatePaymentVerify({ payment_response: btoa(JSON.stringify({ success: false, transaction: TX })), expect: { payee: PAYEE } }).ok).toBe(false);
  });
});

describe("POST /verify/payment verdicts", () => {
  it("match: exact amount, payee, payer, x402 pattern, finality, two witnesses agree", async () => {
    stubFetch(node("rpc-a.test", good), node("rpc-b.test", good));
    const r = await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, payer: PAYER, amount_usdc: "0.02", min_confirmations: 100, x402: true, not_after: "2030-01-01T00:00:00Z" } });
    expect(r.status).toBe(200);
    const d = (await r.json()) as any;
    expect(d.verdict).toBe("match");
    expect(d.settled).toBe(true);
    expect(d.matched_transfer).toMatchObject({ amount_usdc: "0.02", amount_atomic: "20000", from: PAYER, to: PAYEE.toLowerCase() });
    expect(d.checks.every((c: any) => c.pass)).toBe(true);
    expect(d.x402).toMatchObject({ eip3009_authorization_used: true, pattern: "x402_exact_direct", submitted_by: FACIL });
    expect(d.finality).toMatchObject({ block_number: 0x3200000, confirmations: 0x101, is_l1_finalized: false });
    expect(d.counterparty.self_payment).toBe(false);
    expect(d.rpc.independent_rpc_agrees).toBe(true);
    expect(d.rpc.witnesses).toEqual(["rpc-a.test", "rpc-b.test"]);
    expect(d.evidence.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.checked_at).toBeTruthy();
    expect(d.caveats.join(" ")).toMatch(/not yet L1-finalized/);
  });

  it("mismatch: wrong amount reports expected vs actual", async () => {
    stubFetch(node("rpc-a.test", good), node("rpc-b.test", good));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, amount_usdc: "0.03" } })).json()) as any;
    expect(d.verdict).toBe("mismatch");
    expect(d.matched).toBe(false);
    const c = d.checks.find((x: any) => x.check === "amount_exact");
    expect(c).toMatchObject({ expected: "0.03", actual: "0.02", pass: false });
    expect(d.explanation).toMatch(/amount_exact/);
  });

  it("at_least accepts an overpayment", async () => {
    stubFetch(node("rpc-a.test", good), node("rpc-b.test", good));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, amount_usdc: "0.01", amount_match: "at_least" } })).json()) as any;
    expect(d.verdict).toBe("match");
  });

  it("mismatch: wrong payee", async () => {
    stubFetch(node("rpc-a.test", good), node("rpc-b.test", good));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: "0x2222222222222222222222222222222222222222", amount_usdc: "0.02" } })).json()) as any;
    expect(d.verdict).toBe("mismatch");
    expect(d.checks.find((x: any) => x.check === "payee_received_usdc").pass).toBe(false);
  });

  it("fields satisfied only by DIFFERENT transfers is a mismatch (no cross-matching)", async () => {
    const other = "0x4444444444444444444444444444444444444444";
    const logs = [
      { address: USDC_BASE, topics: [TOPIC_TRANSFER, pad(PAYER), pad(other)], data: amt(20000n), logIndex: "0x1" },
      { address: USDC_BASE, topics: [TOPIC_TRANSFER, pad(PAYER), pad(PAYEE)], data: amt(5n), logIndex: "0x2" },
    ];
    const nd = { receipt: receipt({ logs }) };
    stubFetch(node("rpc-a.test", nd), node("rpc-b.test", nd));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, amount_usdc: "0.02" } })).json()) as any;
    expect(d.verdict).toBe("mismatch");
    expect(d.checks.find((x: any) => x.check === "one_transfer_matches_all_fields").pass).toBe(false);
    expect(d.transfers).toHaveLength(2);
  });

  it("a fake token with the same Transfer topic from another contract is ignored", async () => {
    const logs = [{ address: "0x5555555555555555555555555555555555555555", topics: [TOPIC_TRANSFER, pad(PAYER), pad(PAYEE)], data: amt(20000n), logIndex: "0x1" }];
    const nd = { receipt: receipt({ logs }) };
    stubFetch(node("rpc-a.test", nd), node("rpc-b.test", nd));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, amount_usdc: "0.02" } })).json()) as any;
    expect(d.verdict).toBe("no_usdc_transfer");
    expect(d.settled).toBe(false);
  });

  it("not_settled: reverted tx", async () => {
    const nd = { receipt: receipt({ status: "0x0", logs: [] }) };
    stubFetch(node("rpc-a.test", nd), node("rpc-b.test", nd));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE } })).json()) as any;
    expect(d.verdict).toBe("not_settled");
    expect(d.matched).toBe(false);
  });

  it("not_found only after a second node was asked; HTTP 200 and says it is not proof", async () => {
    const calls = stubFetch(node("rpc-a.test", {}), node("rpc-b.test", {}), node("rpc-c.test", {}));
    const r = await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE } });
    expect(r.status).toBe(200);
    const d = (await r.json()) as any;
    expect(d.verdict).toBe("not_found");
    expect(d.explanation).toMatch(/not proof/);
    expect(calls.length).toBe(2); // first node + one more before concluding
  });

  it("falls back when the first node is down", async () => {
    stubFetch(node("rpc-a.test", { fail: true }), node("rpc-b.test", good), node("rpc-c.test", good));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE } })).json()) as any;
    expect(d.verdict).toBe("match");
    expect(d.rpc.primary).toBe("rpc-b.test");
  });

  it("a second node that disagrees is reported", async () => {
    stubFetch(node("rpc-a.test", good), node("rpc-b.test", { receipt: receipt({ blockHash: "0x" + "ee".repeat(32) }) }));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE } })).json()) as any;
    expect(d.rpc.independent_rpc_agrees).toBe(false);
    expect(d.caveats.join(" ")).toMatch(/different receipt/);
    expect(d.verdict).toBe("unconfirmed");
    expect(d.primary_verdict).toBe("match");
    expect(d.matched).toBe(false);
  });

  it("unknown expect key gets a free 422 naming the permitted keys and the likely one", async () => {
    stubFetch(node("rpc-a.test", good), node("rpc-b.test", good));
    const r = await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, amount: "0.02" } });
    expect(r.status).toBe(422);
    const t = JSON.stringify(await r.json());
    expect(t).toMatch(/Permitted keys here: payee, payer, amount_usdc/);
    expect(t).toMatch(/Did you mean 'amount_usdc'\?/);
  });

  it("near-miss keys (truncation/typo) get the nearest permitted key; unrelated keys get none", async () => {
    stubFetch(node("rpc-a.test", good), node("rpc-b.test", good));
    const t1 = JSON.stringify(await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, amount_atomi: "20000" } })).json());
    expect(t1).toMatch(/Did you mean 'amount_atomic'\?/);
    const t2 = JSON.stringify(await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, min_confirmation: 3 } })).json());
    expect(t2).toMatch(/Did you mean 'min_confirmations'\?/);
    const t3 = JSON.stringify(await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, zebra: 1 } })).json());
    expect(t3).not.toMatch(/Did you mean/);
  });

  it("names the rule that chose the suggestion, so the distance rule is observable behind the aliases (gigawatt)", async () => {
    stubFetch(node("rpc-a.test", good), node("rpc-b.test", good));
    const j = async (e: any) => JSON.stringify(await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, ...e } })).json());
    expect(await j({ amount: "0.02" })).toMatch(/Did you mean 'amount_usdc'\? \(rule: alias\)/);
    expect(await j({ amount_atomi: "20000" })).toMatch(/Did you mean 'amount_atomic'\? \(rule: edit_distance\)/);
    expect(await j({ amount_usdcc: "0.02" })).toMatch(/Did you mean 'amount_usdc'\? \(rule: edit_distance\)/);
    expect(await j({ min_conf: 3 })).toMatch(/Did you mean 'min_confirmations'\? \(rule: prefix\)/);
    expect(await j({ zebra: 1 })).toMatch(/No suggestion \(rule: none\)/);
    expect(await j({ paye: "0x" })).toMatch(/\(rule: ambiguous: payee\|payer\)/);
    expect(await j({ amoun: "1" })).toMatch(/\(rule: ambiguous: amount_atomic\|amount_match\|amount_usdc\)/);
    expect(await j({ not_: 1 })).toMatch(/\(rule: ambiguous: not_after\|not_before\)/);
    expect(await j({ paye: PAYEE })).not.toMatch(/Did you mean/);
  });

  it("several logs satisfying the claim are counted and flagged (dedupe by tx_hash+log_index)", async () => {
    const logs = [1, 2].map((i) => ({ address: USDC_BASE, topics: [TOPIC_TRANSFER, pad("0x" + "ab".repeat(20)), pad(PAYEE)], data: amt(20000n), logIndex: "0x" + i.toString(16) }));
    const nd = { receipt: receipt({ logs }) };
    stubFetch(node("rpc-a.test", nd), node("rpc-b.test", nd));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, amount_usdc: "0.02" } })).json()) as any;
    expect(d.matching_transfers).toBe(2);
    expect(d.caveats.join(" ")).toMatch(/2 USDC Transfer logs.*\(tx_hash, log_index\)/);
  });

  it("self-payment (payer == payee) is flagged, not hidden", async () => {
    const logs = [{ address: USDC_BASE, topics: [TOPIC_TRANSFER, pad(PAYEE), pad(PAYEE)], data: amt(100000n), logIndex: "0x1" }];
    const nd = { receipt: receipt({ logs }) };
    stubFetch(node("rpc-a.test", nd), node("rpc-b.test", nd));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, amount_usdc: "0.10" } })).json()) as any;
    expect(d.verdict).toBe("match");
    expect(d.counterparty.self_payment).toBe(true);
  });

  it("time window and confirmations are enforced", async () => {
    stubFetch(node("rpc-a.test", good), node("rpc-b.test", good));
    const d = (await (await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE, not_before: "2030-01-01T00:00:00Z", min_confirmations: 999999 } })).json()) as any;
    expect(d.verdict).toBe("mismatch");
    expect(d.checks.filter((c: any) => !c.pass).map((c: any) => c.check).sort()).toEqual(["min_confirmations", "not_before"]);
  });

  it("payer named in a PAYMENT-RESPONSE header is checked against the chain", async () => {
    stubFetch(node("rpc-a.test", good), node("rpc-b.test", good));
    const liar = "0x9999999999999999999999999999999999999999";
    const hdr = btoa(JSON.stringify({ success: true, transaction: TX, network: "eip155:8453", payer: liar }));
    const d = (await (await post("/verify/payment", { payment_response: hdr, expect: { payee: PAYEE } })).json()) as any;
    expect(d.verdict).toBe("mismatch");
    expect(d.checks.find((c: any) => c.check === "payer_named_in_payment_response").pass).toBe(false);
  });

  it("all nodes down -> 503, charged:false", async () => {
    stubFetch(node("rpc-a.test", { fail: true }), node("rpc-b.test", { fail: true }), node("rpc-c.test", { fail: true }));
    const r = await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE } });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).charged).toBe(false);
  });

  it("stays inside the subrequest budget", async () => {
    const calls = stubFetch(node("rpc-a.test", good), node("rpc-b.test", good));
    await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE } });
    expect(calls.length).toBeLessThanOrEqual(4);
  });
});

describe("payment gate on /verify/payment", () => {
  const PAYVARS = { X402_DISABLED: "0" };
  const facilitator = (u: URL) => {
    if (u.hostname !== "facilitator.payai.network") return undefined;
    if (u.pathname.endsWith("/supported")) return json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    return json({}, 404);
  };
  const decode = (h: string | null) => JSON.parse(atob(h!));
  it("unpaid POST -> 402 at $0.02 with bazaar schema, before any RPC read", async () => {
    const calls = stubFetch(facilitator, node("rpc-a.test", good));
    const r = await post("/verify/payment", { tx_hash: TX, expect: { payee: PAYEE } }, PAYVARS);
    expect(r.status).toBe(402);
    const pr = decode(r.headers.get("PAYMENT-REQUIRED"));
    expect(pr.accepts[0]).toMatchObject({ amount: "20000", payTo: "0x33190c9D2662F94A19CE88EA666f0ff8CeDe3700", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
    expect(pr.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "POST", bodyType: "json" });
    expect(calls.filter((c) => c.includes("rpc-"))).toEqual([]);
  });
  it("empty body / {} -> 402 (discovery probes); GET -> 402; invalid input -> free 422", async () => {
    stubFetch(facilitator);
    expect((await post("/verify/payment", "", PAYVARS)).status).toBe(402);
    expect((await post("/verify/payment", {}, PAYVARS)).status).toBe(402);
    const g = await worker.fetch(new Request("https://stillcurrent.test/verify/payment"), { ...VARS, ...PAYVARS, BOT_CONTACT: "g" + n++ } as any, ctx);
    expect(g.status).toBe(402);
    const r = await post("/verify/payment", { tx_hash: "nope", expect: { payee: PAYEE } }, PAYVARS);
    expect(r.status).toBe(422);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });
  it("discovery documents list the route", async () => {
    stubFetch(facilitator);
    const call = (p: string) => worker.fetch(new Request(`https://stillcurrent.test${p}`), { ...VARS, ...PAYVARS, BOT_CONTACT: "d" + n++ } as any, ctx);
    const o = (await (await call("/openapi.json")).json()) as any;
    expect(o.paths["/verify/payment"].post["x-payment-info"].price.amount).toBe("0.02");
    expect(o.paths["/verify/payment"].post.responses["422"]).toBeTruthy();
    const llms = await (await call("/llms.txt")).text();
    expect(llms).toMatch(/\/verify\/payment/);
    expect(llms).toMatch(/not charged/);
    const w = (await (await call("/.well-known/x402")).json()) as any;
    expect(w.resources.some((x: string) => x.endsWith("/verify/payment"))).toBe(true);
  });
});
