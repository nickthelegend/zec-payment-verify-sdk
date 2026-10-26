# CLI / chain / SDK audit evidence

Executed on 2026-10-26 in worker t3. Contract: the unchanged root AUDIT.md, limited to CLI-001–021, CHAIN-001–018, EDGE-025–040.

Final row results: **48 PASS, 0 FAIL, 7 UNTESTED**. Every row has its command, concrete assertion or exact missing dependency in `audit/status/cli-chain.json`. The supplemental runner writes that JSON after each row. `finalize.py` maps the existing core/SDK test assertions to the remaining rows and writes after each mapping.

## Commands and results

- `python3 audit/cli-chain/run.py core`: `cargo test --release -- --test-threads=1` in packages/core; **25 tests + 1 doc example passed**. Real lightwalletd, actual recorded bytes/compact blocks, published Sapling parameters and real SOCKS forwarding.
- `python3 audit/cli-chain/run.py sdk`: original three SDK Vitest files; **35 tests passed**. Real testnet lightwalletd and Fuji; real dead/silent local sockets for transport and limiter cases.
- `python3 audit/cli-chain/run.py audit`: supplemental `test/audit.test.ts`; **40 tests passed**. Two of those test bodies explicitly record incomplete rows as UNTESTED (funding decryption credential and MCP-specific evidence). A passing test body is not automatically a passing audit row.
- `python3 audit/cli-chain/run.py audit-focused`: EDGE-038 after completing both wrong-selector and non-pool negatives; **1 passed, 39 excluded by the test-name filter**. Real non-pool tx `0x6a7ccb9b9affbc84caf232c84d1a5e20b1dc4fc74c9edb443cc4095ac08ea671` was located read-only in block 57020727, immediately preceding the published wrong-selector pool tx's block 57020728.
- `python3 audit/cli-chain/run.py sdk-build`: SDK TypeScript build passed.
- `python3 audit/cli-chain/run.py audit-types`: supplemental tests strict TypeScript check passed.
- `python3 audit/cli-chain/finalize.py`: row mapping and documentation assertions passed. See documentation.txt.
- `git diff --check` and `git diff --exit-code -- AUDIT.md`: passed.

The driver excludes application credentials from the child environment and redacts encoded viewing credentials before logging. Tests themselves load the project's published demo fixtures. No dotenv, local wallet, spending credential, full viewing credential or operator credential was accessed. Incoming credentials never appear in argv or logs. Evidence is under 0.2 MB; the maximum is 15 MB.

## Incomplete rows and exact dependencies

| Row | Dependency |
| --- | --- |
| CLI-013 | Successful derive requires prohibited full viewing credential access and incoming-key output. Only absent/malformed synthetic-input paths executed. |
| CHAIN-012 | deployments/testnet.json omits the payer's incoming credential. Funding tx is confirmed, authorized and included at height 4522614, but five received notes/amounts cannot be decrypted with the published receiver credentials. |
| CHAIN-016 | SDK settlement passed at block 57020809. Complete cell also requires MCP result owned by the separate MCP task; MCP suites prohibited here. |
| CHAIN-018 | Operator credential and new-root registration. Explicitly left UNTESTED; no credential sought, root registered or transaction submitted. |
| EDGE-037 | A real recorded pending/reverted settle transaction. Both recorded settlements succeeded. Existing rule-only test does not prove this row. |
| EDGE-039 | Browser console/pageerror/network evidence from page-flow task. Browsers/dashboard/heavy slot prohibited here. |
| EDGE-040 | Documentation safety assertions pass, and both sending examples were identified and never executed. Full claim/evidence match inherits the missing five-note funding credential from CHAIN-012. |

`audit-initial.txt` preserves an initial supplemental-check failure: the checker incorrectly assumed the payer credential was published; its helper defaulted to the unrelated x402 receiver when that field was absent. The check now detects the missing published credential explicitly and records UNTESTED. This was a checker error, not evidence that the chain transaction or verifier failed.

## Scope and findings

All ten unique recorded Zcash txids in fixtures/deployments were read through actual GetTransaction/GetBlock/tip calls; the emitted heights/times/depth are in audit.txt. Core recomputes txids, validates authorization and requires compact-block inclusion before returning a report. Additional authorization tests cover re-encrypted 10x notes, proof-byte changes, binding-signature substitutions and wrong/missing transparent previous outputs.

The core transaction parse/txid guard was factored into one private helper shared by inspect and previous-output reads. A new live unit test swaps the two real published transaction byte strings through that same production helper. Existing authorization/inclusion tests now also assert the public inconsistent-answer diagnostic. No core/SDK behavioral defect was found.

Two agreeing reads of testnet.zec.rocks prove quorum arithmetic, not independent operators. The separate real Zaino indexer request returned HTTP503; the SDK returned unverified. Mainnet was queried only read-only to establish missing-testnet-tx disagreement, never to spend.

CHAIN-001's standalone check reconstructed a matching historical invoice in a disposable local memory store: the recorded payment returned 200/success once, then replay402. No gateway suite or production gateway was run. The historical HMAC paywall's recorded success/replay receipts were inspected without representing its expired challenge as a new acceptance.

No Zcash/Fuji transaction was sent, no contract/root deployed or registered, and neither run-live nor paywall-live was executed. No gateway/MCP suites or browsers were run. No commit or push was made, following the authoritative Loom handoff; Loom owns commit/merge.
