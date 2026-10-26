# MCP stdio audit

Scope: unchanged `AUDIT.md`, MCP-001 through MCP-017. Final result: **17 PASS, 0 FAIL, 0 UNTESTED**.

`audit/status/mcp.json` is written after each row. Each `MCP-NNN.json` contains the assertions, real stdio request/response evidence, and safe configuration metadata. Incoming credentials and environment dumps are never serialized. `MCP-004-initial.json`, `MCP-017-initial.json`, `suite-initial.txt`, and `log-initial.txt` preserve failures before their fixes.

## Reproduction and verification

Install with `pnpm install --frozen-lockfile`, then build the SDK and gateway dependencies (`pnpm --filter @zpv/sdk build` and `pnpm --filter @zpv/gateway build`). The runner uses an allowlist of parent environment variables; it does not load dotenv or operator credentials. Tests load the published demo incoming credentials internally, exactly as the existing MCP tests do.

| Command | Result |
| --- | --- |
| `python3 audit/mcp/run.py baseline` | Original `pnpm --filter @zpv/mcp test`: 8/8 passed, before adding the supplemental tests. |
| `python3 audit/mcp/run.py build` | MCP TypeScript build passed. |
| `python3 audit/mcp/run.py types` | Strict supplemental test TypeScript check passed. |
| `python3 audit/mcp/run.py suite` | Required `pnpm --filter @zpv/mcp test`: 25/25 passed, including all 17 audit rows. |
| `git diff --check` | Passed. |
| `git diff --exit-code -- AUDIT.md packages/landing packages/dashboard` | Passed: prohibited files unchanged. |

The supplemental client launches the built `packages/mcp/dist/main.js` over actual stdio, initializes it, and issues `tools/list` and `tools/call`. Its SQLite stores and raw server audit logs live in an isolated `mkdtemp` directory and are removed afterwards. Evidence includes only safe JSON projections. A real local gateway HTTP server consumes one recorded payment in a disposable shared store to verify cross-process replay protection. Its historical challenge memo is pinned locally to the published payment; no new payment is sent.

This worktree had no verifier binary. The runner reused the existing read-only verifier at `/Volumes/Extreme SSD/Projects/grokbot/projects/zec-payment-verify-sdk/packages/core/target/release/zpay-verify`. Compared with that checkout, this worktree's core changes only factor the existing parse/txid checks into a shared helper and add a regression test; MCP does not modify core. No core build, browser, heavy slot, deployment, Zcash/Fuji submission, wallet directory or dotenv file was used. `provenance.json` records binary SHA-256 and tool versions without environment values.

## Original suite mapped to the contract

Numbers below refer to the original test order in `packages/mcp/test/mcp.test.ts`. Every row additionally has a dedicated supplemental test in `packages/mcp/test/audit.test.ts`.

| Rows | Original suite coverage | Supplemental coverage |
| --- | --- | --- |
| MCP-001 | Test 1: list and descriptions | Initialize server name/version; exact tools and floor/binding/replay descriptions. |
| MCP-002–003 | Test 2: paid and wrong memo | Full paid shape; recorded wrong-memo, underpayment, transparent-part and wrong-receiver refusals. |
| MCP-004 | Test 3: default floor and raised caller depth | Configured floor checked/reported, raised caller floor, malformed and out-of-u32 configurations. |
| MCP-005 | Test 8: missing merchant setup | Exact `isError: true`, `Setup required: ZPV_MERCHANT_UIVK`; intentionally missing setup is PASS, not skipped. |
| MCP-006–007 | Tests 4 and 7: annotations and single use | Repeated plain check, description warnings, exact paid memo/tx claims in disposable SQLite. |
| MCP-008 | Test 4: normalized txid replay | Consumed memo with different txid, consumed txid with different memo, and real gateway-to-MCP shared-store replay. |
| MCP-009 | Tests 4 and 5: required memo | Exact store-specific and REQUIRE_MEMO-specific messages. |
| MCP-010 | Not covered | Real concurrent BEING_CHECKED; SIGKILL claimant; exact five-minute lease; expire only disposable timestamps; takeover and stale-token guards; refused/error release then successful retry. |
| MCP-011 | Not covered | Real testnet plus closed local endpoint at quorum 2; real testnet versus mainnet at quorum 1. Both unverified, cross-check details retained, no paid claims. |
| MCP-012 | Not covered | Eleven schema negatives return validation errors before chain reads/store consumption; schema logs contain errors only. |
| MCP-013–014 | Test 6: two real settlements, unbound and wrong recipient | Full response shape, five signals and blocks; wrong payTo/amount; read-only annotation. |
| MCP-015 | Test 1/6 descriptions and repeated recorded settle | Explicit repeated bound success with a store configured; no settlement claims; caller replay-warning assertion. |
| MCP-016 | Not covered | Actual closed-loopback lightwalletd/Fuji dependency failures, isError text, two error logs and no retained claims. |
| MCP-017 | Test 5: new log mode 0600 | New and preexisting 0644 logs become 0600; five completed calls each append once: paid/refused/setup error/schema error/bound Fuji success; exact JSONL fields and credential-absence assertions. |

The real silent TCP endpoint in MCP-010 exercises interruption; it invents no chain response. Five minutes are advanced only in the disposable lease timestamps, not by changing the server clock. Cross-check tests use actual endpoint responses; no independent-operator claim is inferred from repeated reads.

## Fixed failures

- **MCP-004:** A configured floor `4294967296` previously reached the verifier and returned `--min-conf must be a whole number`. `minConfFloor()` now rejects malformed, unsafe, infinite and greater-than-u32 values as `Setup required: ZPV_MCP_MIN_CONF` before verification. The complete row passed again, including 400-digit configuration input.
- **MCP-017:** SDK schema rejection bypassed callback logging: five completed calls yielded four lines. Logging now decorates the public request-handler registration, outside the tool validation callback, so both schema errors and ordinary results append exactly once. The complete row passed for new and existing logs and both tools.

No credentials were missing for these rows. Both recorded Fuji settlements succeeded; this task does not claim to have tested a nonexistent reverted settlement. Missing merchant setup is deliberately exercised as the expected error. No transaction was signed or broadcast.

Changes remain uncommitted, following the authoritative Loom handoff: Loom owns commit and merge. No push was performed.
