# landing

One static page (`index.html`, no build), laid out as an API reference: a section nav on the left
(with a "Jump to…" filter, `/` to focus), prose and parameter lists in the centre, and dark
request/response panes on the right. Every response pane is real output (the CLI, the SDK, the
gateway, or the live run record), dated. TypeScript / Rust / CLI tabs are shared across panes. A
vermilion seal lands once on the first real "paid" response; with reduced motion it is simply there.
Below 1180px the panes follow their section; below 900px the nav becomes a scrolling strip.
Fonts: Hanken Grotesk and JetBrains Mono only.

```sh
python3 -m http.server 5391 --directory packages/landing
```
