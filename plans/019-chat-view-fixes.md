# Plan 019: Chat view stops clobbering the conversation you switched to (plus render throttling and connector error visibility)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 567481d..HEAD -- web/src/pages/ChatView.tsx web/src/components/ChatMessage.tsx web/src/pages/ConnectorsView.tsx server/src/routes.ts`
> On any diff, compare "Current state" excerpts against live code; mismatch → STOP.
> Run AFTER plan 014 (it deletes a placeholder block in ChatView and adds reasoning state).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/014-fix-ingest-name-and-chat-stream-ux.md (same file regions in ChatView)
- **Category**: bug / perf / ux
- **Planned at**: commit `567481d`, 2026-08-23

## Why this matters

1. **Wrong-conversation flip.** While chat A is streaming you can click chat B
   (only *sending* is gated on `stream.running`). When A's stream ends — or is
   aborted via Stop — `send`'s `finally` unconditionally fetches and sets the
   STALE captured `detail` (chat A), replacing B's messages on screen while
   the route still points at B. The visible conversation and the hash route
   disagree until re-click.
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
Meanwhile `loadChat(id)` freely switches chats mid-stream, and per-delta
updates fire here:
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
- `web/src/pages/ChatView.tsx` (stale-refresh guard, delta batching)
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

### Step 1: Guard the post-stream refresh against chat switches

Add `const activeChatIdRef = useRef<string | null>(null);`. Set it in
`loadChat` (after a successful fetch: `activeChatIdRef.current = id`) and in
the initial-load effect; set it to `detail.id` at the top of `send`. In the
finally block:

```ts
    } finally {
      setStream((s) => ({ ...s, running: false }));
      abortRef.current = null;
      if (activeChatIdRef.current === detail.id) {
        const d = await chatsApi.get(detail.id).catch(() => null);
        if (d) setDetail(d);
      }
    }
```

Also refresh the sidebar list unconditionally in the finally
(`loadChats()`) so titles stay current even when the view moved on.

**Verify**: `cd web && npm run typecheck` → 0.

### Step 2: Batch delta updates and memoize message rendering

1. In `send`, accumulate deltas in a local buffer + flush with
   `requestAnimationFrame` (fallback `setTimeout(..., 50)`):

```ts
    let pending = "";
    let raf: number | null = null;
    const flush = () => {
      raf = null;
      const chunk = pending; pending = "";
      if (chunk) setStream((s) => ({ ...s, text: s.text + chunk }));
    };
    // in emit(): case "delta" →
    //   pending += ev.text; if (raf === null) raf = requestAnimationFrame(flush);
```

Flush synchronously when the stream ends: call `flush()` before the finally's
refresh so no tail text is lost, and `cancelAnimationFrame(raf)` in the finally
if it is still scheduled. (If plan 014 added a `reasoning` event handler,
batch it identically.)

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

With dev servers running: (a) start a long answer in chat A; click chat B
mid-stream; when A finishes, B must STILL be displayed and the hash route
unchanged; the A title updates in the sidebar. (b) Stop-generate in A while B
is open → same. (c) Open a long chat (>10 assistant messages), ask a question
and watch: typing/streaming stays smooth; final text complete (no clipped
tail). (d) Create a connector pointing at a URL that returns HTML → card
shows the sync_error reason.

## Test plan

No web test runner exists (per repo convention tests live server/python-side);
verification is the typecheck gate plus Step 4's recorded manual script.
Do NOT introduce vitest/jsdom into web for this plan.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "activeChatIdRef" web/src/pages/ChatView.tsx` → ≥3 occurrences
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
- Delta batching clips the final text in practice despite the explicit end
  flush — report the timing, don't add retries.
- Memoizing ChatMessage breaks chart rendering inside messages (props include
  mutable arrays?) — describe the actual prop flow.

## Maintenance notes

- The stale-guard pattern (ref mirroring selection) is the lightweight fix; a
  keyed per-chat stream owner component would be structural — consider it if
  background streaming across switches ever becomes a feature.
- If chat history grows large enough to matter, virtualize the message list
  BEFORE adding more per-message features.
