# Reference browser audit

Executed only PAGE-009–PAGE-020, EDGE-014, EDGE-016 and EDGE-019 from the unchanged `AUDIT.md` on October 26, 2026. All 15 rows passed their first execution on production and the local reference.

- Real Google Chrome 155.0.8059.85 via Playwright `channel: 'chrome'`, headless, no video or trace.
- Production: `https://hanko-landing-six.vercel.app/reference.html`.
- Local source: `node e2e/serve-static.mjs <free-port>:packages/landing`, bound to `127.0.0.1`.
- Desktop: 1440×900. EDGE-019 and PAGE-011's mobile scroll-spy check: 375×812. EDGE-014: `prefers-reduced-motion: reduce`.
- Every row has a 90-second total deadline and captures console messages, page errors, response status/URL/resource type and failed requests. There were no console errors, page errors, unexpected HTTP 4xx/5xx responses or failed requests.
- JPEG screenshots use quality 42 and are individually checked against a 200,000-byte ceiling. All evidence, including the pre-existing landing audit, remains below 15 MB.
- The status file is written after every completed row; the corresponding JSON contains assertions, network and console records, and screenshot paths. `session.json` records server/browser PIDs, URLs and process exits.

PAGE-020 checks the raw source's relative `dashboard/` link, the production hosted console, and a separately served Pages client build. The raw landing directory contains no dashboard bundle. The Pages client is built from the current dashboard sources using a temporary Vite config with `envDir: false` and `VITE_ZPV_PAGES=1`, avoiding all `.env` access. It opens on the expected null-402 heading; production opens on Zcash and reports the API reachable. No console input values, console screenshots, API response bodies or payment requests are collected.

PAGE-015 checks every code pane in each of TypeScript, Rust and CLI against the actual browser clipboard. PAGE-016 intentionally denies the Clipboard API and controls the legacy copy result to exercise both required fallback branches; it never stubs application network requests. PAGE-017 observes exactly one `press` animation start and checks that its start time does not change after leaving and re-entering the pane.

No product changes were needed. No gateway, stack script, deployment, Zcash send, wallet access or key inspection occurred. The static server and Chrome exited, and the heavy slot was released before task completion. Temporary bundles and dependency symlinks were removed.

To reproduce with the normal repository dependencies installed:

```sh
/Volumes/Extreme\ SSD/Projects/grokbot/tools/heavy-slot.sh acquire audit-t4
node audit/browser-reference/run.mjs
/Volumes/Extreme\ SSD/Projects/grokbot/tools/heavy-slot.sh release audit-t4
```

The runner cleans up its temporary build and server/browser processes in `finally`. Its optional arguments select only assigned row IDs, for example `node audit/browser-reference/run.mjs EDGE-019`; previous attempts remain in the incremental status history. The caller must release the heavy slot even if the runner fails.
