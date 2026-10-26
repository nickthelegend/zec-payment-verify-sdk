# Pages build browser audit

PAGE-036, PAGE-037, PAGE-038, PAGE-039, PAGE-040 and EDGE-021 all passed on
2026-10-26 in Google Chrome 155.0.8059.85 (`channel: chrome`, headless).
No product changes were needed. Results are written after each row to
`audit/status/browser-pages.json`; the row JSON files contain assertions,
console events, requests, responses and request failures. Request bodies and
viewing keys are not recorded. Screenshots mask the viewing-key input.

- Build: `bash scripts/build-pages.sh` passed, including the SDK build.
- Server: `node e2e/serve-static.mjs 5193:site`, bound to `127.0.0.1`.
- PAGE-036 loaded the landing and dashboard at both `/` and
  `/zec-payment-verify-sdk/`. The test-only `site/zec-payment-verify-sdk -> .`
  symlink mounts the exact same build at the repository subpath. Both hero
  image requests succeeded; the built hero bytes equal the source asset.
- PAGE-037 made no request to `127.0.0.1:8403`. The recorded settlement was
  checked live through Fuji, returning true proof/root/spent checks and
  `NULLIFIER_SPENT` / `UNBOUND`.
- No local verify API was running. The expected refused GET to
  `http://127.0.0.1:8403/api/health` and its associated Chrome console message
  are explicitly retained as expected setup events for the Zcash rows.
  Every other request failure, HTTP 4xx/5xx, console error or page error
  fails the affected row. None occurred.
- PAGE-038 passed independently with the setup-required alert, local-network
  explanation and exact command:
  `ZPV_CORS=http://127.0.0.1:5193 pnpm --filter @zpv/gateway api`.
- PAGE-039 checked the matching JSON against the recorded fixture, timestamp,
  source, `Recorded output, not live` labels and absent seal. Wrong memo
  displayed a recorded refusal with `MEMO_MISMATCH` and no seal.
- PAGE-040 checked amount `123`: no matching recording, response JSON or seal.
- EDGE-021 used exactly 375×812, checking proof parameters, live checks,
  rejected tampered proof, two-item history, setup, matching/refused recorded
  results and unmatched parameters. Send controls, badges, hashes, command
  and code panes fit the viewport without horizontal page scrolling.

The runner enforces a 90-second deadline per row. No video or trace is
enabled. All JPEG screenshots are below 200 KB; the entire audit directory
remains below 15 MB. The session manifest records the static server and
Chrome PIDs and confirms both exited. No Zcash transaction, signing,
deployment, commit or push was performed. AUDIT.md was left unchanged.

To repeat from this worktree after installing dependencies:

```sh
bash scripts/build-pages.sh
ln -s . site/zec-payment-verify-sdk
'/Volumes/Extreme SSD/Projects/grokbot/tools/heavy-slot.sh' acquire audit-t8
node audit/browser-pages/run.mjs
'/Volumes/Extreme SSD/Projects/grokbot/tools/heavy-slot.sh' release audit-t8
```

The heavy slot must be released even if the runner fails. Optional runner
arguments select specific rows. The runner starts and stops its own static
server and Chrome; it refuses to run if anything is listening on port 8403.
Evidence is left uncommitted for Loom as required by the worktree handoff.
