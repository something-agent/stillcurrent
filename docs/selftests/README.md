# StillCurrent paid self-tests (2026-10-26)

These are **self-tests**: the payer and the payee are the same operating wallet
(0x3319...3700 is both `from` and `payTo`), so no outside customer paid anything
and no revenue is recorded. They exist to show the full x402 v2 paid path end to
end: 402 challenge -> signed EIP-3009 authorization -> PayAI facilitator settles
USDC on Base -> 200 response with the result.

Client: official `@x402/fetch` + `@x402/evm` + `@x402/core` 2.28.0 with viem.
Each JSON file is the full request/response transcript (headers and bodies);
no keys or tokens are included.

| Route | Price | Settlement tx (Base) | Block | Counterparty |
|---|---|---|---|---|
| POST /check/url | 0.01 USDC | [0x70188b05...5e85330](https://basescan.org/tx/0x70188b05d8eb86db5682e673ece733671e4f8c6d159dd1a597c5148909e85330) | 53117999 | self |
| POST /check/citation | 0.02 USDC | [0x38116bd2...b8cbc60](https://basescan.org/tx/0x38116bd2fec0d8926b31e023cb798a36bd4b052142a4ec0ee65c0d8e6b8cbc60) | 53118002 | self |
| POST /check/urls (6 URLs) | 0.10 USDC | [0x2d3fd6ac...587666c1](https://basescan.org/tx/0x2d3fd6ac0f26fb81d8763c0a4dc723a3e209a9a5da12946cdc6c20dd587666c1) | 53118178 | self |

Each JSON transcript also carries a machine-readable `counterparty` field
(`class`: `self` | `related` | `outside`), so anyone aggregating x402 receipts
can drop self-settlements without reading this README. `related` means a
wallet we control or funded; only `outside` would ever count as revenue.

Gas was paid by the facilitator (0xb2bd2992...f371b via Multicall3), not by us.
