# Hanko — verify shielded Zcash payments with a viewing key

**Demo:** [landing](https://nickthelegend.github.io/zec-payment-verify-sdk/) ·
[console](https://nickthelegend.github.io/zec-payment-verify-sdk/dashboard/), published by
`.github/workflows/pages.yml` on the first push to `main` once Pages is enabled; **not live until
then** (`scripts/build-pages.sh` builds the same site locally). The console opens on its null-402
tab, which runs in the browser against Fuji. Its Zcash tab needs a verify API on your machine; without
one it shows Setup required with the exact command, beside real answers recorded on Oct 22, labelled
"Recorded output, not live". **Video:** not recorded for this version; the Oct 20 terminal capture
(27 s) predates the console, landing, cross-check and SQLite store, so it is not linked.
**Tests:** [TESTING.md](TESTING.md).

**"Was I paid?" for shielded Zcash.** Check that a transaction paid you at least N zatoshi with
memo M, with enough confirmations and no transparent part, using only your **incoming viewing key**
(it sees payments coming in; it cannot spend). The same `verify()` checks a **null-402** Groth16
payment proof against the contracts null-402 deployed on Avalanche Fuji.

A Rust crate + CLI, a TypeScript SDK, an x402 paywall, an MCP server and a dashboard. The core is
extracted from [zec-shielded-x402](https://github.com/nickthelegend/zec-shielded-x402)'s `check_uivk`.

```ts
const r = await verify({ rail: 'zcash', uivk, txid, amountZat: 10_000, memo: 'zpv-…' });
r.ok; r.reasons;   // [] or TX_NOT_FOUND / NO_OUTPUT_TO_KEY / MEMO_MISMATCH / AMOUNT_TOO_LOW / NOT_CONFIRMED / TRANSPARENT_PART

// Don't trust one lightwalletd: any disagreement, or fewer than `quorum` answers, is 'unverified', never paid
const x = await verify({ rail: 'zcash', uivk, txid, amountZat: 10_000, memo }, { lwdUrls: [a, b, c], quorum: 2 });
x.verdict;         // 'paid' | 'refused' | 'unverified'
```

## Live on Zcash testnet

**Current code** (Oct 22, 2026, `pnpm --filter @zpv/examples paywall-live`, `deployments/testnet.json`
`paywallLive`): the production paywall (`dist/main.js`) with nothing pinned issued the stateless memo
`zpv-1792704207-25c57def5e1775f9-_5dMz5gO5ltlrthXMDRcRv`; the employee demo wallet paid 10,000 zat
with it; Shielded x402's own `fetchWithPayment` presented it (402 "payment seen, 0/1 confirmations"
twice, then **200** with `X-PAYMENT-RESPONSE` `success: true`); the same payment again → 402 "this
transaction already paid for a request". Transaction
[`2867d542…664f`](https://testnet.zcashexplorer.app/transactions/2867d542496452326ce241ad3ba647deb7e6e8eb1b889397ffae20dceecb664f)
(block 4,530,239).

Run of Oct 20, 2026 (`deployments/testnet.json`, `pnpm --filter @zpv/examples run-live`). New
demo-only wallets; their incoming viewing keys are published in the record on purpose. All mined
transactions below were re-checked by the merchant's or the employee's viewing key.

| Case | Transaction | The check said |
|---|---|---|
| paywall: `GET /api/quote` → 402, payer sends 10,000 zat with the challenge memo, retries with `X-PAYMENT` | [`7c1f6cc0…`](https://testnet.zcashexplorer.app/transactions/7c1f6cc09a7ae9171beffbbb2dfbf15668431d7b997f742e18706d9296b34c16) (block 4,522,621) | **200**, receipt, memo closed |
| 10,000 zat with another memo | [`1620eccc…`](https://testnet.zcashexplorer.app/transactions/1620eccca54f2558e3cde640f3f378b55278ee5e2e553006cff41bbf238549c0) | 402 `MEMO_MISMATCH, AMOUNT_TOO_LOW` |
| 5,000 zat with the right memo | [`f9db1841…`](https://testnet.zcashexplorer.app/transactions/f9db1841853b2e7befb516b62563c770aceef538769f35a15cd4c4021cf4dce2) | 402 `AMOUNT_TOO_LOW` |
| 10,000 zat with the right memo, plus a transparent output in the same tx | [`bb8d8842…`](https://testnet.zcashexplorer.app/transactions/bb8d88426b96a4cd92ec90446d154de5321da7b2bb863d9249a43838e49a82ec) | 402 `TRANSPARENT_PART` |
| payslip: employer pays 50,000 zat, memo `payslip 2026-10 #7: net 0.0005 TAZ`; a lender checks with the employee's key | [`38958ceb…`](https://testnet.zcashexplorer.app/transactions/38958ceb0ce952ccf6c11003258072dc8ea97f4f6408dc11c2515aeb126b5869) (block 4,522,626) | ok; claiming twice the pay → `AMOUNT_TOO_LOW`; the merchant's key → `NO_OUTPUT_TO_KEY` |
| funding of the demo payer (5 notes) | [`a2c0578b…`](https://testnet.zcashexplorer.app/transactions/a2c0578b58c7c76d989f60292dd445f364fc40e40d1c21f89fc48ece7dfb57d3) | — |

Third-party payments, no new transaction:

| Payment | Key | Result |
|---|---|---|
| zec-shielded-x402 demo payment [`030c3cbf…8351`](https://testnet.zcashexplorer.app/transactions/030c3cbf78ce8460553bba4e82c0ba813f039bd3ecf4d7f2e81c59837dc28351) | x402 merchant's published UIVK | ok, 100,000 zat, memo `x402z-f19a63da20cbc0749ea800b3` |
| sealed-bid auction deposit [`06d12181…0af1`](https://testnet.zcashexplorer.app/transactions/06d121813387444ca3ecc9720e73160b5b80645d9204c6c411e51cef3a190af1) | x402 key / auction's key | `NO_OUTPUT_TO_KEY` / ok |
| null-402 `settle()` on Fuji [`0x8596f52d…a593`](https://testnet.snowtrace.io/tx/0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593) | verifier [`0x0b44836d…6060`](https://testnet.snowtrace.io/address/0x0b44836dDc460f589ce4EB97f276e533A2bE6060), pool [`0x39a9C4Ef…cA1C`](https://testnet.snowtrace.io/address/0x39a9C4EfabEBA954545Ecb4b16Ba1d92ec46cA1C) | proof valid, root known, `NULLIFIER_SPENT`; 10× the amount → `BAD_PROOF` (run of Oct 20; since Oct 21 a check without an expected payTo and amount also says `UNBOUND`); as a settlement: `paid` with the expected payTo, amount and recipient, `UNBOUND` without the recipient |
| the pool's other null-402 `settle()` [`0xd91c0ab7…1e5c`](https://testnet.snowtrace.io/tx/0xd91c0ab7d0d228d003277d62145442b24dcd52492becf561b9977c40fe781e5c) (block 57,020,809) | same verifier and pool | `paid` to its merchant when bound (SDK and MCP live tests) |
| shielding transactions by others, into Sapling [`4a9412fa…8634`](https://testnet.zcashexplorer.app/transactions/4a9412fa75194d31fdae2c796765e1617cdeade286ab231ab75705db827c8634) and Ironwood [`6a508fd3…5126`](https://testnet.zcashexplorer.app/transactions/6a508fd30b6d01c0c428cb15f4b652a8e1879936540951bd4e1b35c2b51e5126) | none (proofs and signatures only) | verify with the outputs their transparent inputs spend; one zatoshi changed → refused |

No contracts are deployed by this project.

## Packages

| Package | What |
|---|---|
| [`packages/core`](packages/core) | `zpay-verify` Rust crate + CLI: fetch, recompute the txid, require it in the compact block at the reported height (and its `block_time`), verify every Orchard/Ironwood/Sapling proof and signature against the recomputed signature hash, trial-decrypt Sapling/Orchard/Ironwood with a UIVK, rules with reason codes, exit 0/1/2; `owns <ua>`; `ZPV_LWD_PROXY` (SOCKS5/Tor); plaintext `http://` only to loopback |
| [`packages/sdk`](packages/sdk) | `@zpv/sdk`: `verify()` with the `zcash` and `null402` rails, a lightwalletd cross-check with a quorum (`lwdUrls` / `ZPV_LWD_URLS`), error classes that say what to do, bounds on running checks (`ZPV_MAX_CHECKS`, `ZPV_MAX_NULL402_CHECKS`, or a `CheckLimiter` per surface), `verifyNull402Settlement`, `ownsAddress`, `proofFromSettleTx`; `@zpv/sdk/null402` runs in the browser |
| [`packages/gateway`](packages/gateway) | x402 paywall in Shielded x402's v1 wire format, tested with Shielded x402's own client module (x402 v1 402 and `X-PAYMENT`; stateless HMAC memos, so GETs store nothing; memo and txid single-use, claimed before the check; mined-time expiry; refused payments that arrived recorded and listed on `GET /api/refunds` with `ZPV_ADMIN_TOKEN`; 5 refused attempts close a challenge, not counting `TX_NOT_FOUND`, and a payment to a closed one is recorded for a refund; its own check slots; lightwalletd down or unverified = 503 + `Retry-After`; startup checks; state in memory or a SQLite file, `ZPV_STORE`) + `POST /api/verify` (verify API only, JSON bodies only) |
| [`packages/mcp`](packages/mcp) | `zpv-mcp`: `verify_zcash_payment` (single-use with `ZPV_STORE`, then annotated not read-only; a `min_conf` floor the model cannot lower) and `verify_null402_settlement` (a successful `settle()` bound to your payee, amount and recipient is paid; a reverted or pending one never is); merchant key from the environment |
| [`packages/examples`](packages/examples) | `run-live` (the Oct 20 table above), `paywall-live` (the current-code payment above) and `demo` (re-checks the recorded run live, no new transactions) |
| [`packages/dashboard`](packages/dashboard) | "Was I paid?" API console: parameters, the exact request, the real response with a seal, reasons, decrypted outputs, provenance; a paid answer without a memo is flagged `NO_MEMO_BOUND`; the hosted build opens on null-402 and shows recorded real output, labelled, when no verify API runs |
| [`packages/docs`](packages/docs) | rules, do X → see Y, trust model, API, the null-402 key mismatch finding |
| [`packages/landing`](packages/landing) | the API reference page: section nav, prose, dark request/response panes of real output |

## Run it

Needs Node 22.13+ (`node:sqlite`), pnpm 10, Rust 1.89 (pinned in `packages/core`), the Sapling
parameters for Sapling transactions (`ZPV_SAPLING_PARAMS`, else the usual ZcashParams folder), and for
`kage-client.test.ts` a checkout of zec-shielded-x402 beside this repo (or `KAGE_X402_DIR`).

```sh
pnpm install
pnpm test                          # builds zpay-verify + packages; 104 tests (49 touch a chain) + 1 doc example (TESTING.md)
pnpm --filter @zpv/gateway api &   # verify API for the dashboard
pnpm --filter @zpv/dashboard dev   # http://localhost:5180
scripts/clean-install.sh           # tarball + cargo install in an empty dir, verifies a real payment
e2e/stack.sh && (cd e2e && npm run test:e2e); e2e/stack.sh stop   # 62 browser tests in Google Chrome
scripts/build-pages.sh             # the static site GitHub Pages serves: landing + console
```

CI: `.github/workflows/ci.yml` runs the same `pnpm test`, and `pages.yml` publishes the landing and
console. Neither has run on GitHub yet: nothing is pushed.
ZIP 311 payment disclosures are not built: [`docs/ZIP-311-DESIGN.md`](docs/ZIP-311-DESIGN.md) says why.

## Honest limits

- **What lightwalletd learns.** Each check asks a lightwalletd for one txid (`GetTransaction`) and
  the compact block it names. The operator learns that this txid matters to you, when you asked, and
  your IP address, which links that payment to you. A cross-check tells every endpoint.
  `ZPV_LWD_PROXY=socks5h://127.0.0.1:9050` (Tor) hides your IP; the txid and the timing are still
  seen. Compact blocks alone would hide the txid, but they carry no memo, and the memo is what ties a
  payment to an invoice.
- **What lightwalletd is trusted for.** The checker recomputes the txid from the bytes it gets,
  requires that txid in the compact block at the height the server reports, and verifies every
  Orchard, Ironwood and Sapling proof, spend authorization signature and binding signature against
  the signature hash it recomputes from the transaction. A swapped transaction, an answer that
  contradicts itself, or a note re-encrypted with another value (anyone can encrypt a note to your
  public address) is refused, live-tested. What it does not check: that the anchors the proofs use
  are real note commitment tree roots, that transparent inputs spend real coins, and the block's
  place in the chain. So a lying lightwalletd that runs a prover over a fake tree, or invents a
  transparent input, and names a block for it can still get a paid verdict. That is why plaintext
  `http://` is refused unless the host is loopback (`ZPV_ALLOW_INSECURE_LWD=1` overrides).
- **The cross-check (`ZPV_LWD_URLS`) only helps when different people run the endpoints.** On
  Oct 22, 2026 hosh.zec.rocks lists two online public testnet indexers, both run by one operator:
  `testnet.zec.rocks` (lightwalletd) and `zaino.testnet.unsafe.zec.rocks` (Zaino, answering 503 that
  day). One server under two spellings is refused as one endpoint twice; the tests that need two
  agreeing answers fetch from testnet.zec.rocks twice and say so. Real independence means running your
  own lightwalletd or Zaino on a full node, which verifies proofs before it serves anything.
- Testnet only.
- A UIVK reveals every incoming payment to its wallet. The keys published here are demo-only.
- The paywall keeps its state in memory by default (a restart forgets which txids paid and which
  refunds are owed); set `ZPV_STORE` to a SQLite file to keep it across restarts and share it between
  processes on one machine (SQLite file locking; not a network database). It will not start with
  `ZPV_MIN_CONF=0` unless `ZPV_ALLOW_ZERO_CONF=1`: mempool transactions can still be replaced.
- Refunds are recorded, not sent: the gateway holds a viewing key, so the merchant refunds by hand.
- The MCP tool remembers accepted payments only with `ZPV_STORE`. Without it the same txid passes
  every check, so an agent must track what it accepted (the tool says so). With it the tool consumes
  the payment and says so in its annotations (`readOnlyHint: false`).
- Without a memo any earlier payment to the key passes; the console flags such a paid answer
  `NO_MEMO_BOUND`.
- The paywall serves `/api/refunds` only with `ZPV_ADMIN_TOKEN`, and `/api/verify` not at all (the
  separate verify API does, to JSON bodies only).
- ZIP 311 payment disclosures (prove one payment without the receiver's key) are not built: the ZIP
  is a draft with no Orchard/Ironwood support, no encoding and no implementation.
- A null-402 check is `ok` only with an expected payTo and amount, and a settlement only with an
  expected recipient as well (otherwise `UNBOUND`): the pool pays whatever recipient `settle()` names.
- A null-402 proof that passes all three checks is not shown live: it needs null-402's pool operator
  to register a new root (`NULL402_OPERATOR_KEY`, not held). **BLOCKED** on that.
- Not published to npm or crates.io (needs the maintainer's npm and crates.io accounts); installable from the packed tarball.
- Portfolio piece; the Zecathon entry is Shielded x402.

MIT — Copyright (c) 2026 Nivesh Gajengi.
