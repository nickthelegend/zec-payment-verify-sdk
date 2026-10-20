# @zpv/mcp

`zpv-mcp`: two read-only tools so an agent (or a merchant's agent) checks a payment before delivering.

| Tool | Checks |
|---|---|
| `verify_zcash_payment` | `{txid, amount_zat, memo?, min_conf?}` against the merchant's incoming viewing key, live on Zcash testnet |
| `verify_null402_settlement` | `{settle_tx, expect_pay_to?, expect_amount?}`: the proof inside a null-402 `settle()` on Fuji, against the deployed verifier and pool |

The merchant key comes from `ZPV_MERCHANT_UIVK` and never passes through the model; without it the
tool answers `Setup required: ZPV_MERCHANT_UIVK`. `ZPV_MCP_LOG` writes one JSON line per call.

Tests (`pnpm test`, 4): a real MCP client over stdio against live testnet and Fuji.
