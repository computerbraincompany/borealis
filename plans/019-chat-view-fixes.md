# Plan 019: Keep every in-flight chat stream attached to its conversation (plus render throttling and connector error visibility)

> **Completed historical plan.** The [ledger](README.md) records this plan as
> DONE. The original instructions, code excerpts, paths, and checklists below
> describe its implementation-era tree; do not execute them against the current
> checkout. For supported behavior and commands, use the [project README](../README.md),
> [API reference](../docs/API.md), and [desktop guide](../desktop/README.md).

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 567481d..HEAD -- web/src/pages/ChatView.tsx web/src/components/ChatMessage.tsx web/src/pages/ConnectorsView.tsx plans/README.md`
> On any diff, compare "Current state" excerpts against live code; mismatch → STOP.
> Run AFTER plan 014 (it deletes a placeholder block in ChatView and adds reasoning state).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (stream state and cancellation become keyed by chat)
- **Depends on**: plans/014-fix-ingest-name-and-chat-stream-ux.md (same file regions in ChatView)
- **Category**: bug / perf / ux
- **Planned at**: commit `567481d`, 2026-08-23
- **Safety revision**: commit `e6e9d2b`, 2026-08-23 — replaced the partial
  final-refresh guard with persistent per-chat stream ownership before
  model/source selectors depend on its gating.

## Why this matters

1. **Wrong-conversation state and lost run ownership.** While chat A is
   streaming you can click chat B, but stream text/tool events and the final
   refresh still mutate one global state object. `loadChat` also resets that
   object. B can briefly display A's activity, A can replace B when it
   finishes, and switching back to A makes its composer look idle even though
   the request is still running. Later model/source selectors would therefore
   be re-enabled and permit a conflicting send or setting change in A.
2. **Main-thread jank that grows with chat length.** Every streamed token
   triggers a state update; every update re-renders ALL prior messages, each
   re-parsing its markdown through react-markdown + highlight.js. Long chats
   get visibly choppy even though the model is the real latency source.
3. **Invisible connector failures.** When creating a connector fails to sync,
   the server returns 200 with a `sync_error` field (`routes.ts:187`) — which
   ConnectorsView throws away, so the card just shows "Last sync: never" with
   no reason.

## Current state

Files and their roles:

- `web/src/pages/ChatView.tsx` — owns chat list, detail state, SSE stream consumption.
- `web/src/components/ChatMessage.tsx` — renders one message's markdown.
- `web/src/pages/ConnectorsView.tsx` — connector cards; create/sync/delete.

Current exact code:

`ChatView.tsx` — `send` captures `detail` at invocation; the finally block
always refreshes THAT chat:
```ts
    try {
      await streamAgentChat(detail.id, content, emit, abort.signal);
    } catch (e: any) {
      if ((e as Error).name !== "AbortError") setStream((s) => ({ ...s, error: e.message || "stream failed" }));
    } finally {
      setStream((s) => ({ ...s, running: false }));
      abortRef.current = null;
      // refresh the conversation from the server (authoritative copy)
      const d = await chatsApi.get(detail.id).catch(() => null);
      if (d) setDetail(d);
    }
```
Meanwhile `loadChat(id)` freely switches chats mid-stream and calls
`setStream(newStreamState())`. Per-delta updates then continue writing to that
same global state:
```ts
      } else if (ev.type === "delta") {
        setStream((s) => ({ ...s, text: s.text + ev.text }));
```
and every message renders through the unmemoized component:
```tsx
            {messages.map((m) =>
              m.role === "user" ? (
                <ChatMessage key={m.id} role="user" content={m.content} />
              ) : ( ... )
            )}
```

`ChatMessage.tsx:50`: `export function ChatMessage({ ... })` — plain
function; internal ReactMarkdown + rehype-highlight re-parse per parent render.

`ConnectorsView.tsx:33-46` — the create response (which may carry
`sync_error`) is discarded:
```ts
      await connectorsApi.create({
        name: name || undefined,
        type,
        config: { url, name: datasetName || undefined },
      });
      setOpen(false);
```
Server side for reference (`server/src/routes.ts`, connector create):
```ts
    } catch (e: any) {
      return reply.send({ ...conn, sync_error: String(e.message || e) });
    }
```

Conventions: functional components + hooks only; named exports; shadcn-style
ui/ primitives. Web has NO test runner — the gate is `npm run typecheck`
(plus manual verification below).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Web typecheck | `cd web && npm run typecheck` | exit 0 |
| Full web build | `cd web && npm run build` | exit 0 |

## Scope

**In scope**:
- `web/src/pages/ChatView.tsx` (per-chat stream ownership, stale-load guard,
  cancellation and delta batching)
- `web/src/components/ChatMessage.tsx` (memoization wrapper only)
- `web/src/pages/ConnectorsView.tsx` (surface sync_error after create)
- `plans/README.md` (status row)

**Out of scope (do NOT touch)**:
- `server/src/*` — the server already sends everything needed.
- The SSE parser in `web/src/lib/api.ts`.
- Tool-feed rendering (`ToolActivity`) beyond what batching touches.
- Plan 014's reasoning/think UI — build on top of its final shape.

## Git workflow

- Branch: `advisor/019-chat-view-fixes`
- Commits per step, conventional style.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Key stream state, cancellation and refreshes by chat ID

In `ChatView.tsx`, replace the single `stream` and `abortRef` with:

```ts
const [streamsByChat, setStreamsByChat] = useState<Record<string, StreamState>>({});
const abortByChatRef = useRef(new Map<string, AbortController>());
const selectedChatIdRef = useRef<string | null>(null);
```

Add a small immutable `updateStream(chatId, updater)` helper. Derive the
visible `stream` from `detail?.id`; a missing entry means `newStreamState()`.
Do not store that fresh default back during render.

Required ownership rules:

- `loadChat(id)` sets `selectedChatIdRef.current = id` before awaiting. Apply
  its response and hash only if the ref still equals `id`, so out-of-order
  chat-detail responses cannot select an older click. Never reset another
  chat's stream entry.
- `send()` captures `const runChatId = detail.id` and rejects only when that
  chat's keyed state is already running. All optimistic state and every SSE
  callback close over `runChatId`; callbacks update only that map entry.
- Store each controller under `runChatId`. Stop aborts only the currently
  visible chat's controller; switching back restores the correct Stop button,
  text, reasoning and tool feed.
- Disable deletion of a chat while its keyed stream is running. Creating or
  opening another chat remains allowed, and another chat may start its own
  run without corrupting the first.
- In `finally`, flush buffered output, mark only `runChatId` stopped, remove
  only its controller, and refresh that detail only when
  `selectedChatIdRef.current === runChatId`. Refresh the sidebar list
  unconditionally so titles stay current.
- Ignore late events after that run's controller has been replaced or removed;
  an older run must never write into a newer run for the same chat.
- After a successful run (and after applying the authoritative refresh when it
  is selected), remove its stopped map entry so completed chats do not
  accumulate in memory. Retain only stopped entries carrying an error; a new
  send or chat deletion clears them. Set `selectedChatIdRef.current = null`
  when the selected chat is deleted.

Keep a stopped entry when it contains an error so later plans can render the
failure after streaming ends. A new send in that chat replaces its entry and
clears the old error.

**Verify**: `cd web && npm run typecheck` → 0.

### Step 2: Batch delta updates and memoize message rendering

1. In `send`, accumulate deltas in a local buffer and flush with
   `requestAnimationFrame` (with a matching `setTimeout` fallback):

```ts
    let pending = "";
    let cancelScheduled: (() => void) | null = null;
    const flush = () => {
      cancelScheduled = null;
      const chunk = pending; pending = "";
      if (chunk) updateStream(runChatId, (s) => ({ ...s, text: s.text + chunk }));
    };
    const scheduleFlush = () => {
      if (cancelScheduled) return;
      if (typeof requestAnimationFrame === "function") {
        const id = requestAnimationFrame(flush);
        cancelScheduled = () => cancelAnimationFrame(id);
      } else {
        const id = window.setTimeout(flush, 50);
        cancelScheduled = () => window.clearTimeout(id);
      }
    };
    // in emit(): case "delta" →
    //   pending += ev.text; scheduleFlush();
```

Flush synchronously when the stream ends: call the matching cancellation
closure, then `flush()` before the finally's refresh so no tail text is lost.
Never cancel a timeout with `cancelAnimationFrame` or vice versa. If plan 014
added a `reasoning` event handler, batch it identically.

2. In `ChatMessage.tsx`: rename the component internally and export a memoized
   wrapper keeping the same named export:
   `export const ChatMessage = memo(function ChatMessage(...) { ... });`
   (add `memo` to the existing `react` import). Props are primitives +
   stable arrays from `meta`, so default shallow comparison is sufficient.

**Verify**: `cd web && npm run typecheck` → 0; `grep -n "memo(" web/src/components/ChatMessage.tsx` → 1+.

### Step 3: Show connector create-time sync errors

In `create()` capture the response and surface `sync_error` instead of
blindly closing:

```ts
      const created = await connectorsApi.create({ ... });
      setOpen(false); ...
      await load();
      if ((created as any).sync_error) setError(null), setCreateNotice(String((created as any).sync_error));
```

Concretely: add `const [createNotice, setCreateNotice] = useState<string | null>(null)`
rendered as a small destructive-tinted line under the affected card (match by
`created.id`) or as a dismissible banner above the grid — pick the card-level
line; clear it on next successful sync. Keep using the existing dialog
`error` state only for thrown (non-200) failures.

**Verify**: `cd web && npm run typecheck` → 0.

### Step 4: Manual verification script (record results)

With dev servers running: (a) start a long answer in chat A; click chat B;
neither A's text/tools nor its final refresh appears in B. Switch back to A:
its live output and Stop button are still present and its Send control is
disabled. (b) While A runs, send in B; both keyed runs complete in their own
histories. Stop A while viewing A and confirm B continues. (c) Click B then C
under delayed detail responses; the last click remains selected. (d) Open a
long chat (>10 assistant messages), ask a question and confirm smooth output
with no clipped tail. (e) Create a connector pointing at a URL that returns
HTML; its card shows the sync error.

## Test plan

No web test runner exists (per repo convention tests live server/python-side);
verification is the typecheck gate plus Step 4's recorded manual script.
Do NOT introduce vitest/jsdom into web for this plan.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "streamsByChat\|abortByChatRef\|selectedChatIdRef" web/src/pages/ChatView.tsx` shows all three keyed-ownership primitives
- [ ] Returning to an in-flight chat shows its own output and disabled Send;
  simultaneous runs in two chats never exchange events or refreshes
- [ ] `grep -n "requestAnimationFrame\|setTimeout" web/src/pages/ChatView.tsx` → batching present
- [ ] `grep -n "memo(" web/src/components/ChatMessage.tsx` → present
- [ ] `grep -n "sync_error" web/src/pages/ConnectorsView.tsx` → present
- [ ] `cd web && npm run typecheck && npm run build` exit 0
- [ ] Step 4 manual scenarios observed and reported
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match live code (esp. post-014 ChatView).
- A stream event cannot be tied to the captured chat/run identity, or a late
  event from a replaced run can still mutate its successor.
- Delta batching clips the final text in practice despite the explicit end
  flush — report the timing, don't add retries.
- Memoizing ChatMessage breaks chart rendering inside messages (props include
  mutable arrays?) — describe the actual prop flow.

## Maintenance notes

- Stream ownership is keyed by chat ID in this MVP. If simultaneous runs per
  same chat are ever desired, promote the key to a server-issued run ID rather
  than weakening the one-run-per-chat guard.
- If chat history grows large enough to matter, virtualize the message list
  BEFORE adding more per-message features.
