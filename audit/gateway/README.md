# Gateway API audit

Scope: API-001 through API-064 in the unchanged `AUDIT.md`. Final row results are in
`audit/status/gateway.json`; each `API-NNN.json` records assertions and real HTTP responses.
`API-NNN-initial.json` preserves a failed initial attempt before a successful rerun. Runner-only
corrections (ephemeral API port discovery, hosted paywall health, and issuing distinct cap memos)
are distinguished from the two gateway fixes below.

## Commands and prerequisites

Dependencies were installed with `pnpm install --frozen-lockfile`, then `pnpm --filter @zpv/sdk build`.
The audit uses the real `packages/core/target/release/zpay-verify` binary. A prebuilt binary was copied
from the existing sibling t3 audit worktree after comparing all core source files, Cargo.toml and
Cargo.lock against this worktree: no differences. This avoided a heavy compilation. The earlier
suite/HTTP attempts used the source checkout's older binary; `suite.txt` and `http.txt` are the final
runs using the matching binary. Ignored build outputs are not deliverables.

Run from the repository root:

```sh
python3 audit/gateway/run.py suite
python3 audit/gateway/run.py http
python3 audit/gateway/run.py regression
python3 audit/gateway/run.py build
```

`run.py suite` runs `pnpm --filter @zpv/gateway test --reporter=verbose`, not the full workspace test
script. The runner preserves only named non-credential environment settings, never loads dotenv,
and redacts viewing-key encodings before terminal output or evidence writes. Fixture credentials
are loaded only internally, following the user's explicit authorization. No key appears in an
argument. Local server processes start with `packages/gateway` as cwd. The HTTP harness uses
fresh SQLite files under `/tmp`; API-059 explicitly tests memory-only restart behavior. The suite's
existing memory-store scenarios are retained. No existing repository database is opened.

## Suite-to-row map

All tests are real implementations: no SDK verifier, store or chain responses are mocked. An
unavailable loopback endpoint exercises an actual failed connection; a silent TCP endpoint exercises
timeout/capacity handling. The existing absence tests perform read-only queries for absent hashes.
All successful/refused-payment checks use recorded txids, without creating a payment. Fuji use is
read-only extraction and `eth_call`. The external hosted API receives only its health GET.

| Gateway suite file | API rows covered or supplemented | Assertions |
| --- | --- | --- |
| `api.test.ts` | 007, 010, 063 | Verify endpoint opt-in; JSON-only gate; separate paywall capacity while free verify slots are held |
| `paywall.test.ts` | 004, 014, 018, 028, 038, 042, 045, 047 | Recorded paid check, CORS, challenge/ZIP-321, malformed/unknown headers and replay |
| `status.test.ts` | 013, 015–017, 020–021, 023, 055 | Caller validation, missing binary, actual failed lightwalletd/Fuji connections, stable key-encoding error |
| `refunds.test.ts` | 024–025, 027, 049–050, 061–062 | Admin authentication, actual received amounts, refund ordering/upsert, mined grace and expired presentation |
| `limits.test.ts` | 022, 051, 053 | 150 concurrent HTTP requests/process cap; six absent checks then paid; five refusals then closed/refunded |
| `store.test.ts` | 047, 056–058 | Real SQLite reopen and shared processes; paid exactly once; stale lease owner cannot release/settle |
| `challenges.test.ts` | 030, 032, 034, 042, 058–060 | 10,001 unpaid GETs with zero stored challenges; methods; authenticated expiry/nonce/tag/resource; HMAC persistence |
| `hardening.test.ts` | 039, 054, 056, 060 | Typed/scalar header errors; real quorum shortfall; simultaneous payment; custom challenge cap/expiry |
| `x402.test.ts` | 028, 040, 044–045, 047 | x402 envelope structure and v1 settlement receipt/replay with the recorded 10,000-zat payment |
| `startup.test.ts` | 064 | Real main.ts startup, invalid numeric/address/key settings, offline ownership, explicit zero-conf opt-in |
| `kage-client.test.ts` | 037; overlaps 045 | External parser/client unavailable: both suite cases report `Setup required: KAGE_X402_DIR`. Only API-037 is UNTESTED; API-045 independently exercises both wire forms over real HTTP. |

Every row not fully covered by that suite has HTTP evidence from `http.ts` / `worker.ts`, including
both actual `api.ts` and `main.ts`, live hosted health and hosted console destination, read-only Fuji
proof verification, report GET/HEAD, startup bounds, paywall BusyError, process interruption/lease
takeover, real stale-owner HTTP loser, SQLite refund persistence and explicit memory-state loss.
The harness writes the status file immediately after each completed row.

## Product fixes

1. API-015: normalize the malformed testnet key error to the documented public error while retaining
   core parser detail inside the SDK. Added a real HTTP regression in `status.test.ts`.
2. API-064: reject confirmation floors beyond the verifier's u32 range, out-of-range prices (including the 5× report amount),
   quorum outside 1..URL-count and quorum without configured URLs before listening. Extended real
   process startup regression cases. Defaults remain minConf 1, quote 10,000, host 127.0.0.1, port 8403.

The hardening test was changed from a mainnet/testnet disagreement to a testnet/closed-loopback
quorum shortfall before that case ran. API-054 permits either. No mainnet endpoint was used by these
audit runs. Every spawned local server was stopped using its own PID; disposable stores were removed.
No browser, signing, transaction sending, deployment, commit or push was performed.

The unavailable external Kage client is the only remaining row dependency: `needs KAGE_X402_DIR`.
The raw scoped suite intentionally reports those two setup failures rather than skipping or mocking
them. See `suite.txt`; passing local wire coverage is in `API-045.json`.
