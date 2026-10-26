# Landing and hero browser audit

Executed only PAGE-001–008, HERO-001–010, EDGE-013 and EDGE-018 on 2026-10-26, using installed Google Chrome 155.0.8059.85 through Playwright's `channel: chrome`. Final result: **19 PASS, 1 FAIL (HERO-009)**. AUDIT.md was not changed.

The live hero exists and returns HTTP 200 image/webp, but Chrome decodes it to **1600×901**. HERO-009 therefore remains FAIL, rather than using the UNTESTED exception for an absent live image. Local source now decodes to **1600×900**. The live deployment requires the corrected asset to be redeployed by its operator; deployment was forbidden for this task.

## Fixes

- `96d03e7`: crop the extra bottom pixel from the existing hero, preserving its composition and producing a 1600×900 WebP (quality 95, 124,738 bytes). HERO-001, HERO-003 and HERO-008 pass after correction.
- `7b02fc9`: register `.webp` as `image/webp` in the static server, after observing `application/octet-stream` in HERO-003. Local source and Pages build now return HTTP 200 image/webp and decode to 1600×900.

PAGE-005 initially had an audit assertion error: `innerText` reflected the existing CSS uppercase transform on “Spend keys.” The assertion now reads DOM text for that label, while separately checking exact facts 104/49/0 and TESTING.md totals. No product change was needed for that row.

## Surfaces and evidence

- Live: https://hanko-landing-six.vercel.app/
- Source landing: `node e2e/serve-static.mjs 5191:packages/landing`.
- Pages: `bash scripts/build-pages.sh site`, served on 5192 using the same static server. `site/` is gitignored. PAGE-003 uses the built deployment locally because it supplies the real dashboard alongside the landing; the standalone source landing contains no dashboard. Actual clicks exercise both hero/end CTAs and both Console navigation links, with same-origin dashboard HTTP 200. No dashboard inputs or response bodies were recorded.
- PAGE rows use both live and source surfaces, except PAGE-003 as explained above. HERO-001 is the disk asset; HERO-002 checks markup on both surfaces; HERO-003 is local serving; HERO-008 is the Pages build; HERO-009 is live. Other HERO motion/paint/mobile rows and both EDGE rows run against live and local.
- EDGE-018 and HERO-010 use 375×812. EDGE-013 and HERO-007 emulate reduced motion. Other animation rows explicitly use no-preference.
- Each row JSON captures assertions, console, page errors, network response status/content type, and failed requests. Every final row has zero console errors, page errors, failed requests, and HTTP 4xx/5xx responses.
- `../status/browser-landing.json` is rewritten after every row. Its evidence arrays retain initial and repeated attempts; the last JSON per row is the final run. JPEGs are at most 60,685 bytes each; all audit evidence is approximately 2.1 MB, below the 15 MB limit. There are no videos or traces.
- Visual review covered desktop 1280×800, mobile headline/CTAs, the settled PAID seal and response, facts, live/setup strip, and footer.

## Execution and cleanup

The `audit-t2` heavy slot was acquired in the foreground before Chrome. A single Chrome/Playwright runner was active at a time, with no video/trace, a 90-second per-row cap, and JPEG screenshots under 200 KB. Serial browser runs repeated checks after fixes and corrected the audit assertion. The two local static ports were owned by one Node process; it was stopped by its exact PID. All browser runners exited and closed their Chrome children, temporary dependency symlinks were removed, and `audit-t2` was released. No gateway, verify API or stack script was started; ports 5180/8403 were not taken. No secrets/wallets were opened, Zcash transaction sent, deployment performed, or changes pushed.

The runner (`run.mjs`) and explicit configuration (`config.json`) are included. It resolves Playwright from `e2e/node_modules`, requires the configured static servers and a separately acquired heavy slot, and supports `--ids=HERO-001,HERO-003` for a bounded rerun. It closes Chrome at completion. Its initial status write and every completed row preserve partial progress if interrupted. Slot/server lifecycle remains the caller's responsibility.
