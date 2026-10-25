# landing

Two static pages, no build:

- `index.html`: the one-screen landing. "Was I paid?", one real request and its response with the
  vermilion seal pressing once on the paid answer (with reduced motion it is simply there), three steps,
  three numbers from TESTING.md and what is live versus Setup required.
- `reference.html`: the API reference (the landing until Oct 25), laid out as API docs: a section nav on
  the left (with a "Jump to…" filter, `/` to focus), prose and parameter lists in the centre, and dark
  request/response panes on the right. Every response pane is real output (the CLI, the SDK, the gateway,
  or the live run record), dated. TypeScript / Rust / CLI tabs are shared across panes. Below 1180px the
  panes follow their section; below 900px the nav becomes a scrolling strip. It also holds the live
  testnet run, the test counts and the trust limits.

Fonts: Hanken Grotesk and JetBrains Mono only.

```sh
python3 -m http.server 5391 --directory packages/landing
```
