# Phase 4 backend re-verification

The contract is the unchanged root `AUDIT.md`: API-001–064, CHAIN-001–018,
CLI-001–021, MCP-001–017, and EDGE-025–040 (136 rows). Final states and exact
expected cells are in `audit/status/reverify-backend.json`. Each row has a fresh
JSON evidence file here. Earlier phase statuses are never used to award a pass.

Final result: **130 PASS, 0 FAIL, 6 UNTESTED**. Core: **25 tests + 1 doc example**;
SDK: **75/75**; gateway: **38/38**; MCP: **25/25**. All three TypeScript package
builds pass. The real HTTP supplement reports **64/64** rows passing.

The two audit test harnesses now accept `HANKO_AUDIT_DIR`, `HANKO_AUDIT_STATUS`
and `HANKO_AUDIT_COMMAND`, preserving their original defaults. This keeps fresh
logs separate from earlier audit evidence. No product behavior changed.

Reproduction from the repository root:

```sh
pnpm install --frozen-lockfile
python3 audit/reverify-backend/run.py core
python3 audit/reverify-backend/run.py sdk-build
python3 audit/reverify-backend/run.py gateway-build
python3 audit/reverify-backend/run.py mcp-build
python3 audit/reverify-backend/run.py sdk
python3 audit/reverify-backend/setup-kage.py
python3 audit/reverify-backend/run.py gateway
python3 audit/reverify-backend/run.py mcp
python3 audit/reverify-backend/run.py http
python3 audit/reverify-backend/finalize.py
python3 audit/reverify-backend/validate.py
```

The runner allowlists runtime/toolchain/certificate variables, excludes application
credentials, and never loads dotenv. Existing tests internally use published demo
incoming credentials, delivered through child environments rather than argv;
encoded credentials are redacted before logs or terminal output. No wallet,
spending key, seed, full viewing key, or operator key is accessed. The successful
derivation path is deliberately not executed.

Core ran with one build job and one test thread against current source. A cloned
copy of the existing Cargo compilation cache avoided recompiling dependencies;
Cargo rebuilt this worktree's changed sources. `provenance.json` identifies the
rebuilt verifier binary, toolchain, revision and unchanged contract hash.

The first gateway run had 36 passing tests and the two known missing
`KAGE_X402_DIR` setup failures. `suite-initial-missing-kage.txt` preserves that
attempt. The public client repository is now available, unlike the prior audit.
Its actual module was fetched into an isolated temporary checkout at revision
`50acc85850aabfde02e6ad334e8cd67eebab8708`, inspected, and used by the rerun.
It has no third-party runtime dependencies. Only its parser and HTTP presentation
client are called; no wallet, facilitator, signing or sending entry point runs.
`kage-dependency.json` records the source. `setup-kage.py` reproduces a pinned,
sparse temporary checkout. The temporary checkout used by this audit is removed
after verification, so reruns should execute the setup command first.

All local SQLite files are created under isolated temporary directories and
removed. Explicit memory-only scenarios test volatile restart behavior. Real
stdio MCP sessions and local HTTP processes exercise replay, cross-process
claims, interruption, lease takeover, refunds, rate/capacity limits and setup
failures. Real dead/silent sockets provide failure and timeout cases; chain
responses and verifier/store implementations are not mocked. Historical challenge
memos are reconstructed only inside disposable stores. No existing repository or
production database is opened.

Ten recorded Zcash transactions are fetched read-only through lightwalletd with
recomputed txids, authorization, inclusion, heights, block times and tips.
Recorded Fuji receipts/calldata and contract calls use public read-only RPC.
`EDGE-026.json` and `sdk.txt` show all three proof checks at one reported block.
Zaino returned HTTP 503; the SDK correctly produced unverified when the second
indexer was unavailable. Repeated reads of one operator prove quorum arithmetic,
not operator independence.

CHAIN-016 combines this phase's SDK result and MCP-013's concrete second-settlement
response. The SDK-only harness conservatively records it incomplete because it
cannot itself establish MCP behavior; the final mapping requires both fresh paths.

The remaining UNTESTED cells document exact dependencies: successful key derivation
(CLI-013), absent published funding receiver credential (CHAIN-012), prohibited
new-root registration (CHAIN-018), unavailable recorded pending/reverted settlement
(EDGE-037), browser-only console/network evidence (EDGE-039), and the full docs
claim/evidence match that inherits CHAIN-012 (EDGE-040). Documentation safety
assertions pass separately; the historical 104-test/49-chain baseline is not
represented as the count of these expanded suites.

No transaction is signed or submitted, no contract/root is deployed or registered,
and neither `run-live` nor `paywall-live` is executed. No browser, heavy slot,
landing/dashboard edit, push, or `.loom/` modification is made. Changes remain
uncommitted because the authoritative Loom handoff assigns commit/merge to Loom.

`summary.json` records final row counts. `validation.json` records suite results,
complete coverage, credential-encoding scan, HTTP process/store cleanup, unchanged
protected files and the total `audit/` size (below 15 MB).
