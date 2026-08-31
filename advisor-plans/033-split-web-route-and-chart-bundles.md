# Plan 033: Split web route and chart bundles with enforced budgets

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none; land before plan 019
- **Category**: performance / web
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

Every route and the ECharts runtime are statically imported into one initial
1.353 MB minified / 422 kB gzip JavaScript artifact. Vite warns about the chunk,
and desktop launch parses features the user has not opened.

## Target contract

- Auth and the chat shell form the bounded initial path.
- Sources, libraries, agents, automations, connectors, reports, and Settings are
  route-level lazy chunks with accessible loading fallbacks.
- ECharts and `ChartCard` load only when a message actually renders a chart.
- All chunks are content-hashed, included in the copied desktop runtime, served
  from the exact Fastify origin, and usable offline under the production CSP.
- A deterministic build-budget check limits initial JS gzip size and fails when
  the route/chart split collapses. It reports paths/sizes only, no source maps.

## Scope

- `web/src/App.tsx`, chart/message composition, Vite config, loading UI/tests
- a read-only bundle-budget script and package/policy/CI wiring
- static hosting and desktop-copy tests where needed

## Implementation steps

1. Convert non-initial pages and Settings to `React.lazy`/dynamic imports while
   preserving hash-route behavior and Settings' underlying workspace state.
2. Dynamically load the chart renderer only for chart metadata; avoid one
   suspense boundary blanking an entire completed assistant message.
3. Add stable vendor chunking only where measurement supports it; do not hide a
   regression by increasing Vite's warning threshold.
4. Generate a Vite manifest and add a budget check for initial entry gzip size,
   maximum lazy chunk size, and presence of separate chart/route chunks.
5. Test direct navigation, lazy-load failure, Settings overlay, offline static
   hosting, desktop copy, and a message with and without a chart.

## Verification

- Web tests/typecheck/lint/format/build and bundle budget; server static-hosting
  tests; desktop verify/package lifecycle; `pnpm verify`.

## Done criteria

- [ ] Initial JS is below the committed measured budget.
- [ ] ECharts is absent from the initial dependency graph.
- [ ] Every route works by direct hash navigation and in the packaged app.
- [ ] CI fails a future accidental eager import.

## STOP conditions

- Lazy chunks require network or paths outside the exact packaged static origin.
- Splitting causes authenticated effects to run before desktop bootstrap.
