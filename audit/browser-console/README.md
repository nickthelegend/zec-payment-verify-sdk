# Hosted and local console audit

Executed PAGE-021 through PAGE-035 from the unchanged `AUDIT.md` on October 26, 2026.

- Hosted console: **15/15 PASS**, `https://hanko-dashboard-six.vercel.app`.
- Local dashboard dev server using the hosted verify API: **7/15 PASS**; PAGE-024 through PAGE-031 **FAIL** because the hosted API rejects the local origin's preflight. The affected rows remain FAIL in `audit/status/browser-console.json`.
- Both surfaces pass initial state, request preview, all three null-402 checks, and rail switching after a real null-402 result.
- No dashboard product defect was found. The remaining fix requires changing the hosted API/reverse-proxy CORS configuration to allow `http://localhost:5180` on OPTIONS and POST `/api/verify`. No deployment or server configuration change was performed.

`cors-investigation.json` records read-only OPTIONS responses: neither `http://localhost:5180` nor `http://127.0.0.1:5180` receives `Access-Control-Allow-Origin`; the production dashboard origin does. GET health succeeds on the local dashboard, but that does not establish that JSON POST preflight is permitted. Chrome records the corresponding CORS console errors and `net::ERR_FAILED`. This is not excused as an expected verification failure. PAGE-024 was re-run twice with the same result, including a masked local failure screenshot.

Each row JSON records exact assertions, safe response JSON, console messages, page errors, network URL/method/status, failed requests, and screenshots. Status was written after every row. The status file includes separate hosted/local outcomes, so a hosted pass is preserved when its paired local flow fails. PAGE-030 checks all three real example history entries and explorer links. PAGE-031 completes eleven real hosted checks, verifies the latest ten and count, then verifies reload resets history. Its local execution fails at the first blocked verify request. PAGE-035's final execution starts with the real spent null-402 proof on both surfaces, switches to Zcash, and verifies verdict/seal clearing, request parameters, send button and preserved history; it also switches back. The earlier Zcash-first attempt is retained.

Real Google Chrome 155.0.8059.85 ran through Playwright `channel: 'chrome'`, headless, at 1440×900. No video, trace, mocks, routing, CORS bypass or local gateway was used. Each paired row has a 90-second total deadline. JPEG screenshots use quality 38 and are checked to be at most 200,000 bytes. The whole `audit/` directory remains below 15 MB.

The local server uses `envDir: false` and an explicit `VITE_ZPV_API` definition for `https://hanko-api.201-18-198-162.sslip.io`. It serves the dashboard development source, not a Pages build. Only the application loads published fixtures and sends their preset keys to the intended API. The runner never reads key input values, fixture source responses or POST bodies. Key fields are masked in screenshots, and the request pane contains only the application's shortened key. Text evidence is additionally redacted. Response data contains no viewing key. No wallet, seed, spending key, `.env` file, Zcash send, deployment or Pages build was accessed or executed.

`session-*.json` records browser and server PIDs and their exits. Every browser/server process started by the runner is closed in `finally` and terminated by PID if still running; the temporary Vite configuration is removed. The shared heavy slot was acquired as `audit-t6` before Chrome and released after final verification. No commits or pushes were made, following the authoritative Loom session handoff that reserves commits/merging for Loom.

Reproduce with workspace and `e2e` dependencies installed:

```sh
pnpm --filter @zpv/sdk build
/Volumes/Extreme\ SSD/Projects/grokbot/tools/heavy-slot.sh acquire audit-t6
node audit/browser-console/run.mjs
/Volumes/Extreme\ SSD/Projects/grokbot/tools/heavy-slot.sh release audit-t6
```

Optional arguments select only assigned row IDs, such as `node audit/browser-console/run.mjs PAGE-024`. Attempts accumulate; status reflects the latest run. Release the slot even if execution fails.
