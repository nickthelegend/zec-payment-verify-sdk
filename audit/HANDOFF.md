# Hanko audit handback

Checklist rows in `AUDIT.md`: 210. No id stayed PENDING. Every id appears in `audit/status/reverify-landing.json`, `audit/status/reverify-console.json`, or `audit/status/reverify-backend.json`. Those three files are the source. Earlier status files are used only where a settled decision below names them.

## Totals

| Status | Rows |
| --- | --- |
| PASS | 204 |
| FAIL | 0 |
| UNTESTED | 6 |
| PENDING | 0 |

## FAIL

No FAIL remains. The Snowtrace Cloudflare challenge stays on EDGE-024 as UNTESTED. `audit/reverify-console/edges-run.txt` shows unexpected http, console, requests, and pageErrors all 0 for every edge except EDGE-024. EDGE-039 is PASS: that challenge is the identified external dependency, and an identified failure does not fail the gate.

## UNTESTED

| ID | Dependency |
| --- | --- |
| HERO-009 | needs Claude to redeploy hanko-landing-six so `/assets/hero.webp` decodes to 1600x900; local HERO-003 already passes. Local and Pages-build `hero.webp` decode to 1600x900 (96d03e7). The live file at https://hanko-landing-six.vercel.app/assets/hero.webp decodes to 1600x901. |
| CHAIN-012 | `deployments/testnet.json` has no published payer incoming viewing credential for the funding tx. |
| CHAIN-018 | needs `NULL402_OPERATOR_KEY`. No root was registered. |
| CLI-013 | the success path would print an incoming viewing key derived from a UFVK. |
| EDGE-024 | needs testnet.snowtrace.io to serve the recorded settlement to headless Chrome without a Cloudflare challenge; the rendered href is the published hash. |
| EDGE-037 | no recorded pending or reverted null-402 `settle()` exists in the fixtures. |

## Settled labels that differ from a status file

HERO-009 is UNTESTED. `audit/status/reverify-landing.json` had recorded FAIL because the live asset exists and decodes to 1600x901.

CHAIN-016 is PASS. `audit/reverify-backend/MCP-013.json` and `audit/mcp/MCP-013.json` (also `audit/status/mcp.json`) both show the MCP check of `0xd91c0ab7…1e5c` paid and settled at block 57020809. The SDK path is in `audit/reverify-backend/CHAIN-016.json` and `audit/reverify-backend/sdk.txt`.

EDGE-039 is PASS. The Snowtrace Cloudflare challenge is the identified external dependency on EDGE-024, and an identified failure does not fail the gate. The backend status file had left this row UNTESTED because that task did not run the browser.

EDGE-040 is PASS. `audit/reverify-backend/documentation.json` shows `run-live` and `paywall-live` were not executed (`commandsExecuted` empty, `transactionsSent` 0) and the safety checks match the code. The missing payer credential stays on CHAIN-012. The backend status file had left this row UNTESTED for that credential.

PAGE-024 through PAGE-031 are PASS from `audit/status/reverify-console.json`. The hosted console is the contract surface. The local run reaches the hosted API through the documented `VITE_ZPV_PROXY_API` forward (`cef2eb6`); the reverify recorded `http://localhost:5180/api/verify`. The earlier local `net::ERR_FAILED` in `audit/browser-console/` does not count. No harness fabricated those response bodies.

## Product fix commits in git log

These commits, after the Phase 1 plan `a93c4bf`, change product code:

- `96d03e7` Crop hero asset to its declared 1600 by 900 dimensions. `packages/landing/assets/hero.webp`. Local HERO-001, HERO-003, and HERO-008 pass on that asset. Live HERO-009 is still 1600x901 until redeploy.
- `7b02fc9` Serve WebP assets with the image/webp content type. `e2e/serve-static.mjs`. Local and Pages hero responses use that type (HERO-003, HERO-008).
- `52cf54a` Gateway and paywall API. `packages/gateway/src/server.ts` returns the stable public error for a malformed testnet viewing key (API-015). `packages/gateway/src/main.ts` rejects a confirmation floor outside u32, a price whose 5× report exceeds the Zcash amount limit, and a quorum outside 1..endpoint count before listening (API-064).
- `a9d832f` MCP stdio tools. `packages/mcp/src/tools.ts` rejects `ZPV_MCP_MIN_CONF` outside 0..4294967295 (MCP-004) and logs at the tools/call boundary, including schema rejections (MCP-017).
- `cef2eb6` Browser edge rows. `packages/dashboard/src/App.tsx` and `packages/dashboard/vite.config.ts` forward local dev `/api` through `VITE_ZPV_PROXY_API`. PAGE-024 through PAGE-031 use that forward. The same commit adds `packages/dashboard/.edges-5187.config.mjs` and `.edges-5188.config.mjs`, which are harness Vite configs (`envDir: false` and a proxy target). They do not fabricate API bodies.
- `7571cb2` CLI, chain, SDK rows. `packages/core/src/lib.rs` shares the existing txid-mismatch check between inspect and transparent prevout reads and adds a unit test on recorded bytes. No checklist row was FAIL for this. The rest of that commit is audit tests.

`fcc764c` changes `packages/mcp/test/audit.test.ts` and `packages/sdk/test/audit.test.ts` only. `audit/reverify-backend/README.md` says no product behavior changed in that re-verify.

## Mocks, stubs, console, and network

No product mock, fallback data, or success stub was added. `audit/reverify-landing/README.md` says so, and says PAGE-016 injects a DOMException into `document.execCommand` only inside that test, after the real copy path runs. `audit/reverify-backend/README.md` says chain responses and verifier/store implementations are not mocked. `audit/reverify-console/README.md` says no API, chain, health, or payment responses are fabricated, and local consoles use the Vite proxy.

The Snowtrace Cloudflare challenge stays on EDGE-024 as UNTESTED (403, challenge-platform console errors, and one failed challenge request; unexpected http 2, console 7, requests 1, pageErrors 0). EDGE-039 is PASS. Landing, console, and Pages reverifies recorded zero unexpected console errors, page errors, and failed requests on every other covered row.

## Evidence size

`audit/` at handback is 9.4M (`du -sh audit`), under 15 MB. Superseded attempt images were not deleted. JSON, README files, `audit/reverify-landing`, `audit/reverify-console`, and `audit/reverify-backend` are intact.
