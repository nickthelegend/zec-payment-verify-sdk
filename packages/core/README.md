# zpay-verify (Rust)

Verify an incoming shielded Zcash payment with only the receiver's **incoming viewing key** (UIVK).
Extracted from zec-shielded-x402's facilitator `check_uivk` (same author, MIT); same pinned
pre-release librustzcash line (NU7 / Ironwood on testnet), Rust 1.89.

```rust
let v = zpay_verify::verify(lwd_url, uivk, txid, &Expect { amount_zat: 100_000, memo: Some("inv-42".into()), min_conf: 1, shielded_only: true }).await?;
if v.verdict.ok { /* paid */ } else { println!("{:?}", v.verdict.reasons) }
```

It fetches the tx from lightwalletd, re-computes the txid, fetches the compact block at the height
lightwalletd reports and requires the txid in it (`check_inclusion`; the block's time is reported as
`block_time`), verifies every proof and signature in the transaction (`auth`: each Orchard and
Ironwood bundle's Halo 2 proof, spend authorization and binding signatures, and each Sapling bundle's
Groth16 proofs and signatures, against the ZIP 244 signature hash recomputed from the transaction;
for transparent inputs it fetches the outputs they spend from the same server), trial-decrypts every
Sapling, Orchard and Ironwood output with the key, then applies the rules in `check()`. Proofs or
signatures that do not verify are an inconsistent answer (exit 2, never a verdict). A Sapling
transaction needs the Sapling parameters (`ZPV_SAPLING_PARAMS`, else the usual ZcashParams folders;
checked against their published BLAKE2b hashes): without them it is `Setup required`. The Orchard
verifying keys are built in-process (about 2 s per run).

What still rests on the server: that the anchors the spends prove against are real note commitment
tree roots, that transparent inputs spend real unspent outputs, that nullifiers are unspent, and the
block's place in the chain. So a lying lightwalletd can no longer hand over a made-up or altered transaction without valid proofs and signatures, but one that runs a prover over a fake note commitment tree, or invents a transparent input, still can; a server willing to forge the block too is believed.

`tests/auth.rs` (live): the published x402 payment passes; the same payment with its note made worth
ten times as much and re-encrypted to the same address (the rules alone would call it paid) is
refused; a changed proof byte or another transaction's binding signature (the txid stays the same,
since ZIP 244 txids do not cover authorization data) is refused; two third-party shielding
transactions (one into Sapling, one into Ironwood) verify with their real previous outputs and fail
with an input amount changed by one zatoshi or with none; a Sapling transaction without the
parameters is `Setup required`.

| Reason | When |
|---|---|
| `TX_NOT_FOUND` | lightwalletd does not know the txid (or only on an orphaned fork) |
| `NO_OUTPUT_TO_KEY` | the tx exists but pays nothing this key can see |
| `MEMO_MISMATCH` | outputs to the key exist, none with the expected memo |
| `AMOUNT_TOO_LOW` | outputs with the expected memo sum below the amount |
| `NOT_CONFIRMED` | fewer confirmations than `min_conf` (0 while in the mempool) |
| `TRANSPARENT_PART` | `shielded_only` and the tx has a transparent input or output |

Bad keys, bad txids and network failures are errors, never verdicts.

## CLI

```sh
ZPV_UIVK=uivktest1… zpay-verify verify <txid> --amount 100000 --memo inv-42 [--min-conf 1] [--allow-transparent]
#   prints {"report":…,"verdict":…,"lightwalletd":…}; exit 0 paid, 1 not paid, 2 could not check
ZPV_UIVK=… zpay-verify inspect <txid>...     # what the key sees, no rules
ZPV_UFVK=… zpay-verify derive                # UFVK → UIVK (share the incoming-only key)
ZPV_UIVK=… zpay-verify owns <utest1…>        # does this address belong to the key? exit 0 yes, 1 no, 2 not an address (offline)
```

The key is read from the environment only. `ZPV_LWD_URL` overrides `https://testnet.zec.rocks:443`.

- Plaintext `http://` is refused unless the host is loopback (a lightwalletd on this machine) or
  `ZPV_ALLOW_INSECURE_LWD=1`: over plaintext, anyone on the path can answer for the server.
- `ZPV_LWD_PROXY=socks5h://127.0.0.1:9050` (Tor) sends the connection through a SOCKS5 proxy, so the
  lightwalletd operator sees the proxy's address instead of yours (`socks5h` lets the proxy resolve
  the name; `socks5` resolves it here). If the proxy is down the check fails with exit 2; it never
  falls back to a direct connection. Library: `verify_with(url, &ConnectOptions { proxy, allow_insecure }, …)`.

Tests: `cargo test` — 3 rule tests; `tests/live.rs` (7) on real testnet txs decrypted with keys their
owners published (`../../fixtures/testnet.json`, `../../deployments/testnet.json`), including the real
compact block with the tx taken out; `tests/transport.rs` (4) and `tests/cli.rs` (6) for the proxy and
plaintext rules and `owns` (offline); the doc example compiles.
