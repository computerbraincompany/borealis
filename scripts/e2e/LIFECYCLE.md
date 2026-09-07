# Process lifecycle acceptance

Run from the repository root using Node 22 and already-built production output:

```bash
pnpm test:e2e:product:lifecycle --evidence-dir=/absolute/new/evidence-directory
```

The command does not build or package. It creates its own private disposable
workspace, local provider, local WebDAV transport, and product-owned stdio tool.
Every product launch runs the actual `server/dist/index.js`; no runtime service,
clock, ledger, or transport implementation is replaced. Public authenticated API
requests create the synthetic data. SQLite inspection is read-only.

The default command must finish all seven named cases and the scheduled catch-up
case inside `brief`. Its content-free summary records completed cases, compiled
runtime file hashes, exact checks, and final process/lock/workspace cleanup.
`--case=research|rewrite|mcp|analysis|render|knowledge|brief` is a diagnostic subset
whose summary names that restricted scope; it is not full lifecycle acceptance.
`--keep-on-failure` retains only the owned synthetic diagnostic workspace.

| Required boundary | Real process proof |
| --- | --- |
| Research interruption | SIGKILL after the first comparison cell is committed; a new process opens the same stores and finishes the same run. Exactly two correctly bound cells remain, with preserved values/scope/evidence and byte-identical captured evidence rows. In-progress synthesis may replace its attempt timestamps under the existing store contract. No document appears automatically; one explicit artifact action creates one draft. |
| Rewrite and research shutdown | Two actual provider calls are held in progress. Unquiesced SIGTERM drains both. The rewrite becomes failed, does not replay, and leaves the source revision unchanged; the research run resumes through a new process. |
| Chat and MCP child | The real selected stdio tool writes its own PID/dispatch receipt while holding its call. SIGTERM terminates the active chat and child. Reopening cannot replay the external dispatch. |
| Analysis | SIGTERM interrupts a running expensive DuckDB analysis. Its durable run is terminal, no partial result appears, and reopening cannot replay it. |
| Document rendering | A publication intent and actual renderer child processes are observed concurrently. SIGTERM must wait for a terminal publication response and renderer children, then release stores and the lock without escalation. If Playwright's signal handler cancels PDF output, require the durable PDF error, no partial publication/files, and no automatic retry. An explicit retry of that operation produces one valid PDF, preserved after another reopening. A completed publication is also verified and never repeated. |
| Knowledge refresh | A real managed WebDAV item has ready content. A fixed local proxy holds the next real transport request; SIGTERM must abort it, finish cancellation, preserve the entire prior ready-source row, and close the socket before exit. Reopening does not resume cancelled work. |
| Brief execution | SIGTERM interrupts a real narrative call after the analysis result has committed. Reopening reuses the same run/result, creates exactly one reviewed draft and notification, never publishes, and deduplicates the accepted operation. Another real reopen cannot duplicate anything. |
| App closed across due time | A real daily schedule targets the next minute. The process exits before its stored due time and stays absent while that actual wall-clock instant passes (at most one minute). Reopening produces exactly one scheduled catch-up, advances the cursor, and another reopen does not repeat it. No clock or stored timestamp is edited. |

This companion deliberately signals active work without the browser harness's
optional readiness/quiescence gate. It detected three production regressions:
late-idle HTTP keepalive sockets prevented shutdown after publication, and
knowledge cancellation escaped or outlived its durable finalizers, while the
OpenAI SDK's abort error incorrectly marked interrupted briefs as failures
instead of preserving their resumable stage. Their focused
regressions and this actual-process command cover different parts of the fix.

Other required lifecycle dimensions remain independently covered:

- `server/src/tests/shutdownDrain.test.ts` sends real SIGTERM during ingestion
  and DuckDB work and proves process exit and lock release.
- The native A–F runner observes the desktop-only scheduled knowledge watcher
  active before ordinary Cmd+Q, then checks the same durable refresh, descendant
  processes, and profile locks. See [NATIVE_DESKTOP.md](NATIVE_DESKTOP.md).
- `calendarSchedule.test.ts` covers spring/fall transitions in multiple zones,
  ambiguous/nonexistent local times, local/UTC previews, and injected-clock
  missed-window collapse. `briefRunner.test.ts` covers overlap, cancellation,
  failure boundaries, and recovery at each committed stage.
- `serverApp.test.ts`, `applicationRuntime.test.ts`, `knowledgeWatch.test.ts`,
  `knowledgeRoutes.test.ts`, and `knowledgeRefresh.test.ts` prove drain ordering,
  held finalizers, admission closure, and retained ownership when closure fails.
- The browser A–F journeys, focused product integrations, live local inference,
  populated migration/archive companion, export visual review, and native
  packaging gates remain separate required acceptance evidence. This command
  does not claim to replace those gates.
