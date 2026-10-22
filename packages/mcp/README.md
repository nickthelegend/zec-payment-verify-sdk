# @zpv/mcp

`zpv-mcp`: two read-only tools an agent (or a merchant's agent) calls before it delivers.

| Tool | Answers |
|---|---|
| `verify_zcash_payment` | `{txid, amount_zat, memo?, min_conf?}`: did this transaction pay the merchant, checked with the merchant's incoming viewing key, live on Zcash testnet |
| `verify_null402_settlement` | `{settle_tx, expect_pay_to?, expect_amount?, expect_recipient?}`: was this mined null-402 `settle()` on Fuji a payment to me |

The merchant key comes from `ZPV_MERCHANT_UIVK` and never passes through the model; without it the
tool answers `Setup required: ZPV_MERCHANT_UIVK`.

**Replay.** A check on its own does not use a payment up: without `ZPV_STORE` the same txid passes
every time it is asked, and without a memo any past payment to the merchant passes. The tool says so
in its description and answers `single_use: false`; the caller has to record the txids it accepted
and always pass the invoice memo. With `ZPV_STORE=<file>` (the gateway's SQLite store)
`verify_zcash_payment` needs a memo and accepts each payment once: the memo and txid are claimed
before the check and marked paid after it, and a second call answers `ALREADY_USED`. A paywall on
the same file shares that memory.

**Settings the model cannot change** (server environment): `ZPV_MCP_MIN_CONF` (default 1) is the
lowest `min_conf` a call may use, and a lower one is raised to it (the answer reports the `min_conf`
used); `ZPV_MCP_REQUIRE_MEMO=1` requires a memo even without a store; `ZPV_LWD_URLS` (+
`ZPV_LWD_QUORUM`) cross-checks every payment and adds `cross_check`.

**null-402.** A reverted or pending `settle()` paid nobody: never ok (`SETTLE_REVERTED`,
`SETTLE_PENDING`, verdict `unsettled`). A successful one is `paid` when its proof is valid, its root
known, its nullifier spent by this settlement, and the payee signal and amount are `expect_pay_to`
and `expect_amount` (and the pool paid `expect_recipient`, if given). `proof_check` is the other
question, "could this proof still be settled to me": always `NULLIFIER_SPENT` once settled. The tool
does not remember settlements already accepted.

`ZPV_MCP_LOG` writes one JSON line per call, with decrypted memos and amounts, so the file is created
(and kept) with mode 0600.

Tests (`pnpm test`, 7, 4 live): a real MCP client over stdio. The tool list (the descriptions name
the replay rule); the published x402 payment ok and a wrong memo refused; `min_conf: 0` raised to 1
and a deeper one honoured; with `ZPV_STORE` the payment is ok once and `ALREADY_USED` the second
time, and a memo is required; `ZPV_MCP_REQUIRE_MEMO` and a 0600 log; both real `settle()` calls on
the Fuji pool `paid` when bound, `UNBOUND` without expectations, `RECIPIENT_MISMATCH` for another
recipient; Setup required without the key. There is no reverted `settle()` on the pool to test (all
7 of its transactions succeeded); the SDK tests the rule for reverted and pending.
