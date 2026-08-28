# UI/UX reconstruction specification

> **Historical design proposal — 2026-08-22.** These requirements describe
> a possible North-equivalent rebuild, not an accepted Borealis roadmap or its
> implemented architecture. See the [archive overview](README.md),
> [current Borealis docs](../../README.md), and
> [completed implementation plans](../../plans/README.md).

**Status:** independent interface design requirements informed by documented behavior and public screenshots<br>
**Rule:** reproduce workflows, not Cohere branding or pixel-level presentation

## 1. Product shell

### 1.1 Desktop layout

```text
┌──────────────┬──────────────────────────────────────────┬──────────────────┐
│ primary nav  │ main route / conversation / builder      │ contextual panel │
│ + history    │                                          │ sources/trace/   │
│              │                                          │ files/details    │
└──────────────┴──────────────────────────────────────────┴──────────────────┘
```

- Collapsible primary navigation with visible selected route.
- Main surface maximizes working area.
- Right contextual panel appears for citations, source preview, agent/workflow details, sandbox files, or run/node inspection.
- Split editor/chat layout for documents and some table/report workflows.
- Responsive tablet mode collapses contextual panel to a drawer; mobile supports chat/basic review, not full graph building.

The documented Chat shell includes Home, Inbox, Agents, Automations, Tables, Sources, recent conversations, composer, user/settings, and role-gated Admin/Developer links.[13]

## 2. Route map

```text
/
/home
/chat/new
/chat/:conversationId
/agents
/agents/:agentId
/agents/:agentId/build
/agents/:agentId/evaluate
/agents/:agentId/history
/automations
/automations/discovery
/automations/runs
/automations/builds
/automations/monitor
/automations/:id/run
/automations/:id/build
/runs/:runId
/reviews/:reviewTaskId
/tables
/tables/:tableId
/sources/files
/sources/libraries
/sources/connections
/artifacts
/artifacts/:artifactId
/settings/profile|appearance|language|notifications|memory|connections
/admin/overview|people|permissions|models|tools|agents|automations|guardrails|audits|analytics|configuration
```

Routes preserve deep links and back/forward behavior. Unsaved drafts use explicit guards; long-running tasks survive navigation.

## 3. Navigation behavior

### Primary user nav

- Home
- Agents
- Automations
- Tables (feature/permission gated)
- Sources with My Files, Libraries, Connected Sources
- Artifacts (recommended independent addition)
- Recent conversations grouped by relative date and searchable
- Inbox/notifications
- User menu

### Agent gallery

Tabs/filters: Discover/Company, Shared, Starred, Mine, Drafts. Cards show name, description, owner, maturity/certification, connected capability/source badges, live version, visibility, last update, and starters. The documented product supports browse, star, sort, start-chat, and ownership-specific management.[26]

### Automations

The documented tabs are Discovery, Runs, My builds, and Monitor.[27][32]

## 4. Chat UX

### 4.1 Empty state

- Selected default/custom agent identity and concise purpose.
- Up to four clickable starters.
- Active model and capability badges.
- Explanation of source/tool scope and egress/action risk.
- No decorative empty state that hides controls.

### 4.2 Composer

```text
[+ Attach] [@ mentions]  Ask a question…                 [Model ▾] [Send]
[Agent] [File] [Library] [Web] [Data] [MCP tool] [Egress: local]
```

- Multiline input with keyboard/help.
- Large-paste chip at documented 1,000-character threshold.[13]
- File/library/source/tool picker with search, categories, maturity, auth/sync status, and action/egress label.
- Model/reasoning only where configurable.
- Active chips removable before send.
- Send disabled only with a clear reason; Escape/cancel during stream.

### 4.3 Message presentation

- User message content parts: text, paste, file mentions, images.
- Assistant content streams progressively with stable layout.
- Safe execution summary above answer; expandable tool/resource steps.
- Citation-underlined claims and citation count pill; side panel with claim-specific and all-source modes.[15]
- Retry, copy, feedback, open artifact, and export actions.
- Tool approval rendered as a platform-owned modal/card, visually impossible for MCP Apps to spoof.
- Errors inline with request ID, retryability, and recovery action.

### 4.4 States

```text
idle → submitting → streaming → completed
                    ├─ waiting_approval
                    ├─ moved_to_background
                    ├─ cancelled
                    └─ failed
```

Never replace partial output with a spinner. Preserve content on retry/failure and distinguish network reconnect from model/tool failure.

## 5. Citation/source panel

- Header: source title, type, freshness/version, access state, open/download.
- Claim mode: exact contributing snippet/locator and highlighted response span.
- All sources mode: grouped deduplicated list.
- File viewer with page/section navigation; table/tool output with monospace/structured view.
- Current citation index persists while panel collapses/reopens.
- Revoked source displays unavailable state without leaked snippet.

Public image `screenshots/contract-citations.png` shows highlighted document evidence; it is reference evidence, not a layout to copy.[5]

## 6. Agent builder

### Layout

```text
┌────────────── builder form ──────────────┬──────── live preview ────────┐
│ Basics | Model | Instructions | Tools    │ isolated one-off chat       │
│ Sources | Access | Evaluate              │ draft/version badge         │
└──────────────────────────────────────────┴──────────────────────────────┘
```

- Autosave status (`Saving…`, `Saved`, `Error—retry`).
- Draft/live/semantic version badge.
- Publish changes with validation summary, semver type, notes, and visibility.
- History drawer with read-only version preview and restore warning.
- Evaluate tab with tasks, cases, runs, pass/fail, judge model, duration/tokens.
- Permission/source/model consequences shown before publication.

Public image `screenshots/create-agent-form.png` confirms a create-agent flow organized around Basics, Tools, and Access.[6]

## 7. Automation builder

### Canvas

- Pan/zoom/minimap, keyboard navigation, selection, auto-layout + undo.
- Add menu split into Components and Behaviors.
- Node cards show type, name, configuration validity, model/agent/tools, output schema, retry/fallback, test status.
- Typed ports and edges; branches labeled.
- Inspector tabs Configure/Advanced/Testing.
- Inputs/output template control panel.
- Validation drawer with click-to-focus issues and AI-fix proposal diff.

Reference: `screenshots/automation-builder-node.png`.[6]

### Run surfaces

- Discovery card/detail: owner, version, notes, inputs, tools/connections, action risk, tasks, prior runs.
- Run form with typed validation/defaults and dependency auth checks.
- Run viewer: step list/graph, active node, inputs/outputs, retries, waiting review, final artifact.
- Runs tab: Active, Scheduled, Completed; status/trigger filters and search.
- Monitor table: automation, status, runner, start, duration, tokens, queue/review time, failure class.

### Human review

- Platform-owned page with workflow/node/version, instructions, source/output context, typed fields, expiry, and submit confirmation.
- Text, file, and single-select fields; required markers and upload checks.
- Single-winner submission feedback; stale/expired/access-revoked states.
- Decision summary becomes an immutable run event.

## 8. Document editor

- Split chat/editor.
- Structured rich-text editor with selection toolbar.
- Inline request: concise/expand/rewrite/translate/custom.
- Whole-document instruction through chat.
- Generating state locks only affected document/selection; cancel available.
- Version dropdown and read-only diff with additions/deletions.
- Citations rendered as semantic marks/pills.
- Embedded chart/table/artifact nodes.
- Export/share with exact version selection and permissions.

Document Mode's documented behaviors include manual edits, selection/whole-document AI changes, suggested edits, charts, agent-driven versions/diff, export, and read-only session snapshots.[20]

## 9. Tables UI

- Virtualized grid; sticky headers and primary column.
- Column editor: type, AI toggle, prompt, `@` column refs, files, tools, model, output constraints.
- Per-cell states with icons/tooltips: manual, queued, running, generated, reviewed, stale, failed.
- Selection action bar: run/rerun/review/unreview/cancel.
- Bulk-run preview and progress counts.
- Expanded cell panel: full value, citations, safe trace, dependencies, run history.
- Reviewed cells protected from bulk replacement; stale warning after dependency/config changes.[21]

Reference: `screenshots/trend-forecasting-table.png` and `screenshots/revenue-agent-table.png`.[5][6]

## 10. Sources UI

### My Files

- upload/drop zone;
- processing/index state, size/type, duplicate/version, owner, last used;
- preview/download/delete;
- clear storage limits and deletion consequences.

### Libraries

- My/Shared/Company tabs;
- source, owner, visibility, role, sync state/window/counts;
- item search/manage;
- grant editor and recipient validation;
- agent/chat attachment picker.

### Connections

- connector card: state/maturity, data path (`live/indexed/hybrid`), auth health, scope, last sync/freshness, permission model, action/egress class;
- Connect/Re-authenticate/Manage scope/Sync/Disconnect;
- job history and partial failures.

## 11. Admin application

Use a visually distinct but design-consistent admin shell:

- Overview: deployment/model/search/storage/queue/backup/egress health.
- People & access: users, groups, roles, service identities.
- Resources: agents, models, tools/MCP, automations, libraries.
- Policy: permissions, guardrails, flow control, approvals, retention/deletion, memory, features.
- Security/compliance: audit, exceptional access requests, encryption/key status, OAuth apps.
- Experience: branding, language, banners, terms, feedback.
- Operations: logs config, metrics/traces links, support bundle, version/updates.

Bulk/all-user grants require impact preview. Dangerous settings need reason, re-authentication/dual control where appropriate, and rollback.

## 12. Visual design rules

- Project-owned name, logo, iconography, color, typography, motion, illustrations, and copy.
- Neutral high-density enterprise UI with clear hierarchy; no imitation of North's green/black art direction or card compositions.
- Light/dark themes are tokenized.
- Capability/source/tool/maturity/risk badges use text + icon, never color alone.
- Red reserved for destructive/error; amber for warning/stale/review; green for verified/ready/success.
- Long IDs/technical details live in inspectable details, not primary copy.
- UI copy names consequences: “shares these files,” “uses external network,” “creates a Jira issue,” not vague “Enable.”

## 13. Accessibility

- WCAG 2.2 AA target.
- Full keyboard navigation for composer, menus, gallery, tables, side panels, approval/review, and builder inspector.
- Workflow canvas has a parallel ordered-list/graph-outline editor and screen-reader descriptions.
- Visible focus, skip links, semantic landmarks/headings, live regions for stream/task state.
- Reduced motion; no flashing; user-controlled animation.
- Contrast and non-color state indicators.
- Tables expose row/column headers and virtualized accessibility strategy.
- Diffs use text labels in addition to color/strikethrough.
- Charts provide title, summary, data table/download, and high-contrast palette.
- Generated content never bypasses sanitization or heading/link accessibility checks.

## 14. Localization

North documents multiple UI languages and translation actions.[13][20]

- externalize all UI/error/notification/export strings;
- locale-aware dates/numbers/timezones/plurals;
- RTL-ready layout;
- user-entered names/content are not automatically translated;
- model-generated quick actions declare source/target language;
- server errors return stable codes; clients localize messages;
- workflow/tool schemas support localized labels without changing canonical keys.

## 15. Loading, empty, failure, and permission states

Every route/component must design:

- initial loading and incremental loading;
- empty first-use and empty filter result;
- permission denied vs not found;
- feature disabled vs unavailable dependency;
- offline/reconnect;
- expired/revoked connection;
- queued/running/background;
- partial sync/parse/run success;
- stale/deleted reference;
- retryable/non-retryable failure;
- destructive confirmation and post-action verification.

## 16. Screenshot evidence boundary

The curated folder contains 18 verified public product images and a contact sheet, with URL/hash metadata in `screenshots/sources.json`. It covers the primary workspace, Automations, chat, citations, tables, agent cards, agent creation, generated documents/reports, and builder nodes.[5][6][62]

Use it to validate feature inventory and interaction relationships only. Do not copy layouts pixel-for-pixel or ship the images.

## Sources

[5] https://cohere.com/north
[6] https://cohere.com/north/agent-studio
[13] https://private.docs.cohere.com/docs/get-started/north-chat
[15] https://private.docs.cohere.com/docs/get-started/using-citations
[20] https://private.docs.cohere.com/docs/get-started/north-document-mode
[21] https://private.docs.cohere.com/docs/get-started/north-table-mode
[26] https://private.docs.cohere.com/docs/get-started/agents/agent-library
[27] https://private.docs.cohere.com/docs/get-started/north-automations
[32] https://private.docs.cohere.com/docs/get-started/north-automations/consuming-automations
[62] https://cohere.com/north/workplace-productivity
