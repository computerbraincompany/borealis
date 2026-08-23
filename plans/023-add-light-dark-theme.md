# Plan 023: Give the whole web app a persistent light, dark and system theme

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first, after dependencies)**:
> `git diff --stat e6e9d2b..HEAD -- web/index.html web/tailwind.config.js web/src/main.tsx web/src/index.css web/src/components/ThemeProvider.tsx web/src/components/ThemeMenu.tsx web/src/lib/chartTheme.ts web/src/components/ui/dropdown-menu.tsx web/src/components/ui/button.tsx web/src/components/ui/badge.tsx web/src/components/Shell.tsx web/src/components/ChartCard.tsx web/src/components/ChatMessage.tsx web/src/components/ToolActivity.tsx web/src/components/ModelSelector.tsx web/src/components/ChatSourcePicker.tsx web/src/pages/AuthPage.tsx web/src/pages/ChatView.tsx web/src/pages/SourcesView.tsx web/src/pages/ConnectorsView.tsx web/src/pages/ReportsView.tsx plans/README.md`
> Plans 013, 014, 019, 021 and 022 intentionally change this surface. Confirm
> their final ModelSelector, ChatSourcePicker, ChatView and ChatMessage code is
> present, then reconcile every changed file against this plan. Any unexplained
> mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (broad visual sweep plus canvas charts that do not inherit CSS)
- **Depends on**: `plans/013-remove-north-branding.md`, `plans/014-fix-ingest-name-and-chat-stream-ux.md`, `plans/019-chat-view-fixes.md`, `plans/021-select-chat-model.md`, `plans/022-scope-chat-data-sources.md`
- **Category**: direction / ux / accessibility
- **Planned at**: commit `e6e9d2b`, 2026-08-23

## Why this matters

The app is permanently dark even though Tailwind is already configured for
class-based theming. Removing the root `dark` class today produces unreadable
sidebars, overlays, markdown, syntax highlighting, status badges and chart
canvas text because many colors bypass the semantic token system. This plan
makes Light and Dark explicit user choices, adds System as a convenience,
persists the device preference without a flash, and verifies every route and
new chat control in both resolved themes.

## Current state

Relevant exact code at `e6e9d2b`:

`web/index.html:2` forces dark before the app loads:

```html
<html lang="en" class="dark">
```

`web/tailwind.config.js:3` is already ready for the desired controller:

```js
darkMode: ["class"],
```

`web/src/index.css:6-27` puts the dark palette in `:root` rather than `.dark`:

```css
:root {
  --background: 226 45% 8%;
  --foreground: 216 33% 94%;
  --card: 225 42% 11%;
  /* ... */
}
```

The same file hard-codes dark scrollbar, markdown, code, table and embedded
chart surfaces at `:40-135`. `web/src/main.tsx:3` permanently imports
`highlight.js/styles/github-dark.css`.

Representative dark-only component styles:

- `Shell.tsx:27`: `bg-[#0b0f1d]/80`
- `ChatView.tsx:157`: `bg-[#0b0f1d]/60`
- `ToolActivity.tsx:25`: `bg-[#0c1120]/90`
- `ChatView.tsx:236,254,280,290` and several other views use
  `border-white/*` or `bg-white/*` as dark overlays.
- `ui/badge.tsx:14-15` uses dark-only emerald/amber text.
- Error boxes use `text-destructive-foreground` on translucent backgrounds,
  although that token is intended for solid destructive fills.

`web/src/components/ChartCard.tsx:85-93` normally uses the persisted ECharts
option returned by the server, and its effect depends only on `data`:

```ts
const option = data.echarts ?? (data.spec ? optionFromSpec(data.spec) : null);
if (!option) return;
if (!chartRef.current) chartRef.current = echarts.init(ref.current);
chartRef.current.setOption(option);
```

The persisted option has fixed light chart chrome from
`python/app/charts.py:101-157`, while ChartCard's fallback at `:31-59` has
fixed dark chrome. CSS theme changes cannot repaint either canvas path.

The repo's UI requirements are explicit:
`docs/cohere-north/12-ui-ux-reconstruction-specification.md:251-271` requires
tokenized light/dark themes, contrast, text+icon status, visible focus and
high-contrast charts. Research screenshots are reference evidence only;
`docs/cohere-north/screenshots/README.md:40-42` forbids shipping or copying
their proprietary design.

### Scope decision: exported reports remain fixed light

`python/app/reports.py:91-192` builds a self-contained light document and
`build_pdf()` at `:195-200` prints that same HTML. `ReportsView.tsx:135` embeds
it in an isolated `srcDoc` iframe. A browser preference must not silently alter
portable HTML/PDF artifacts or make exports vary by the viewer's device.

Keep the report iframe's `bg-white` as an explicit allowlist and change its
dialog description to say the export uses a light, print-oriented document
theme. A future themed-export request needs its own persisted report payload,
Python CSS/chart and PDF compatibility plan.

### Expected prerequisite state

- Plan 021 has created `ModelSelector.tsx` and accessible dropdown radio
  primitives.
- Plan 022 has created `ChatSourcePicker.tsx` and placed both controls/chips in
  the composer.
- Plans 014/019 have finalized reasoning, placeholders, stream batching and
  chat-switch guards.

Those new controls are in this plan's theme audit even though they did not
exist at the planned commit. Do not omit them from the sweep.

Conventions to preserve:

- Semantic colors are CSS custom properties consumed through Tailwind names
  (`bg-background`, `bg-card`, `text-muted-foreground`, etc.).
- Components are named React functions and reuse local Radix/Lucide primitives.
- Aurora colors are project-owned accents; theme them for contrast rather than
  replacing the identity or copying upstream styling.
- No web test runner exists. Static gates are typecheck/build plus the explicit
  browser verification matrix below.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Web typecheck | `cd web && npm run typecheck` | exit 0 |
| Web production build | `cd web && npm run build` | exit 0; existing bundle-size warning allowed |
| Tailwind literal sweep | `rg -n '(bg|text|border|ring|from|via|to)-\[#|(bg|text|border|ring|from|via|to)-(white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(/|-[0-9]|\b)' web/src` | only the `ui/dialog.tsx` black scrim and `ReportsView.tsx` white report iframe remain |
| CSS/JS/config literal sweep | `rg -n '#[0-9A-Fa-f]{3,8}|rgba?\(|hsla?\([[:space:]]*[0-9.]|hsl\([[:space:]]*[0-9.]' web/src web/index.html web/tailwind.config.js` | only the unchanged canonical data-series palette in `web/src/lib/chartTheme.ts` remains; UI/chrome colors live as HSL-triplet custom-property values |
| Static dark theme | `rg -n 'github-dark|class="dark"' web/src web/index.html` | no forced/imported theme hits |

Baseline at `e6e9d2b`: `npm run build` succeeds.

## Scope

**In scope**:

- `web/index.html`
- `web/tailwind.config.js`
- `web/src/main.tsx`
- `web/src/index.css`
- `web/src/components/ThemeProvider.tsx` (create)
- `web/src/components/ThemeMenu.tsx` (create)
- `web/src/lib/chartTheme.ts` (create)
- `web/src/components/ui/dropdown-menu.tsx` (reuse/finish radio primitives)
- `web/src/components/ui/button.tsx`
- `web/src/components/ui/badge.tsx`
- `web/src/components/Shell.tsx`
- `web/src/components/ChartCard.tsx`
- `web/src/components/ChatMessage.tsx`
- `web/src/components/ToolActivity.tsx`
- `web/src/components/ModelSelector.tsx` (from plan 021)
- `web/src/components/ChatSourcePicker.tsx` (from plan 022)
- `web/src/pages/AuthPage.tsx`
- `web/src/pages/ChatView.tsx`
- `web/src/pages/SourcesView.tsx`
- `web/src/pages/ConnectorsView.tsx`
- `web/src/pages/ReportsView.tsx`
- `plans/README.md`

**Out of scope (do NOT touch)**:

- `python/app/reports.py`, `python/app/charts.py`, stored chart specs/options,
  report HTML/PDF appearance, or regenerated artifacts.
- The canonical chart data/series palette. Theme chart chrome around the
  canonical colors; do not create app/report data-color drift here.
- A settings route, server/account preference, profile synchronization,
  branding redesign, responsive-navigation rewrite, or new UI dependency.
- Functional behavior of model/source selection, chat streaming or reports.
- Copying assets, layouts, exact colors or trade dress from research images.

## Git workflow

- Branch: `codex/023-light-dark-theme`
- Commit per logical layer: provider/tokens, controls/sweep, charts/verification.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Apply the preference before React paints

Create `web/src/components/ThemeProvider.tsx` with this public contract:

```ts
type ThemeChoice = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: ThemeChoice;
  resolvedTheme: ResolvedTheme;
  setTheme(theme: ThemeChoice): void;
}
```

Required behavior:

- Persist under `borealis_theme`, matching `borealis_token`/`borealis_user`.
- Default to `system` and follow
  `matchMedia("(prefers-color-scheme: dark)")` while System is selected.
- Catch localStorage and matchMedia failures; fall back to light without
  breaking render.
- Listen to `storage` events so another tab updates promptly.
- Toggle only the root `.dark` class, set root `style.colorScheme`, and update
  `meta[name="theme-color"]` to the resolved background.
- Expose a `useTheme()` hook that throws a clear developer error outside the
  provider.

Replace the hard-coded root class in `web/index.html` with a small pre-render
bootstrap in `<head>` that applies stored/system state before CSS/React paints.
It must share the exact key/validation rules above, contain no network call,
and tolerate blocked storage. Add two `theme-color` meta entries only if their
media behavior stays synchronized; otherwise let the provider update one.

Wrap `<App />` in the provider in `main.tsx`.

**Verify**: `cd web && npm run typecheck && npm run build` -> 0;
`rg -n 'class="dark"' web/index.html` -> no matches. Reload both stored themes
with cache disabled -> no opposite-theme flash.

### Step 2: Define light/default and dark token sets

In `web/src/index.css`:

- Make `:root` the light theme and move/refine the current palette under
  `.dark`.
- Keep the existing shadcn token names and add only semantic needs such as
  `--sidebar`, `--surface-subtle`, `--code-background`, `--code-foreground`,
  `--success`, `--success-foreground`, `--warning`, `--warning-foreground`,
  `--aurora-teal|blue|violet|green`, `--aurora-foreground`, and chart-chrome
  text/grid/line/tooltip tokens.
- Use HSL triplets so Tailwind opacity modifiers still work.
- Add `color-scheme: light` / `dark` through the resolved root class so native
  form controls and scrollbars match.

Use this reviewed accent target (convert to HSL triplets in the variables):

| Semantic accent | Light | Dark |
|-----------------|-------|------|
| Aurora teal | `#0e8173` | `#2dd4bf` |
| Aurora blue | `#0a5adb` | `#60a5fa` |
| Aurora violet | `#6b26d9` | `#a78bfa` |
| Success/green | `#157f3c` | `#4ade80` |

These light values are dark enough for text on a near-white canvas; the dark
values remain bright on the current near-black canvas. Treat them as starting
tokens and verify actual contrast rather than trusting color appearance.

In `web/tailwind.config.js`:

- Change fixed `aurora.*` colors to
  `hsl(var(--aurora-*) / <alpha-value>)` and add
  `aurora.foreground`, `success`, `warning`, `sidebar` and subtle-surface
  mappings.
- Keep all existing semantic names stable so stock UI primitives continue to
  work.

Replace every hard-coded scrollbar/markdown/table/blockquote/code/chart
container color in `index.css` with semantic variables. Remove the
`github-dark.css` import from `main.tsx` and define a compact local Highlight.js
theme using variables for background, text, comment, keyword, string, number,
title and addition/deletion groups under the two token sets.

**Verify**: typecheck/build. The static theme search returns no forced dark
stylesheet. Markdown plain/code/table/link/blockquote samples remain legible in
both modes.

### Step 3: Add an accessible Light/Dark/System menu

Reuse the Radix dropdown radio group/items created by plan 021. If their
semantics are incomplete, fix the wrapper once in
`components/ui/dropdown-menu.tsx`; do not create a second menu abstraction.

Create `ThemeMenu.tsx`:

- Trigger icon reflects resolved theme (Sun/Moon); menu items are Light, Dark
  and System (Monitor) with radio state.
- Trigger has visible focus, `aria-label="Appearance"`, a mode-specific title,
  and a screen-reader label.
- Full keyboard navigation and Escape behavior comes from Radix.
- No page reload is required.

Mount it beside sign-out in `Shell.tsx` and at the top-right of `AuthPage.tsx`,
because logged-out users never render Shell. Appearance persists across
login/logout; `clearSession()` must continue removing auth keys only.

**Verify**: keyboard-only selection works on auth and authenticated shells;
reload and a second tab reflect changes; changing OS preference updates only
while System is selected.

### Step 4: Replace dark-only component styling with semantic tokens

Audit every in-scope component, including `ModelSelector` and
`ChatSourcePicker` added by the previous plans. Required replacements:

- Hex sidebars/tool surfaces -> `bg-sidebar`, `bg-card`, `bg-muted` or
  `bg-surface-subtle` according to hierarchy.
- `border-white/*` -> `border-border` or a semantic foreground opacity.
- `bg-white/*` dark overlays -> `bg-muted/*` or `bg-accent/*`.
- `text-slate-950` on aurora gradients -> `text-aurora-foreground`.
- Fixed emerald/amber status text -> `text-success` / `text-warning` and keep
  text+icon labels per the design requirement.
- Translucent error boxes -> `text-destructive`; reserve
  `text-destructive-foreground` for solid destructive fills.
- Card hover borders, tool-feed states, thinking/reasoning details, composer,
  model/source menus/chips, report links and empty states must all use tokens.

Intentional static allowlist:

- `ui/dialog.tsx` may retain a black translucent modal scrim.
- `ReportsView.tsx` may retain the white report iframe.
- Brand gradients must use the project-owned Aurora custom properties and a
  tokenized foreground. The portable SVG logo may retain its embedded colors.

Update the report-preview description to clarify that the embedded/exported
document intentionally uses a light, print-oriented theme.

**Verify**: run both literal sweeps. The Tailwind sweep has only the two
path-specific allowlist hits above. The CSS/JS/config sweep has only the eight
unchanged canonical data-series values centralized in `chartTheme.ts`; it has
no UI/chrome literals. Review and record every remaining line; do not suppress
a path or replace one unexplained literal with another.
`web/public/aurora.svg` is outside the command by design.

### Step 5: Repaint ECharts chrome on resolved-theme changes

Create `web/src/lib/chartTheme.ts` with a pure transform that deep-clones a
persisted/fallback ECharts option and overlays presentation-only values from a
resolved token snapshot:

- transparent background and default text;
- title/subtitle;
- legend;
- x/y axis label, name, line and split-line;
- tooltip background, border and text;
- pie labels and label lines.

Do not change categories, values, series types, canonical `option.color`, or
explicit series/pie item colors. Those data colors also drive reports/PDFs and
must stay stable in this plan.

Move the existing eight-value `AURORA_PALETTE` from `ChartCard.tsx` into this
module as `CANONICAL_CHART_PALETTE` without changing any value. It is the sole
CSS/JS/config color-literal allowlist and is shared by the fallback builder;
persisted options retain their own canonical palette unchanged.

In `ChartCard.tsx`:

- Read `resolvedTheme` through `useTheme()`.
- Resolve chart-chrome CSS variables once per repaint.
- Apply the transform to both `data.echarts` and `optionFromSpec` fallback.
- Include `resolvedTheme` in the effect dependency and call
  `setOption(themedOption, { notMerge: true })`; canvas pixels do not respond to
  CSS alone.
- Keep resize registration/cleanup and chart disposal correct.
- Theme switching must not refetch chart data.

**Verify**: with one axis chart and one pie/donut, switch Light/Dark/System
while open. Titles, labels, axes, grids, legends, tooltips and pie labels repaint
immediately; data/series colors and values remain unchanged.

### Step 6: Run the full visual and accessibility matrix

With the web app running, inspect:

- Logged-out Auth and every logged-in route: Chat, Sources, Connectors, Reports.
- Light, Dark and System; persisted reload, OS change in System, and cross-tab.
- Desktop plus a narrow viewport.
- Keyboard focus/menu operation, inputs, dialogs, scrollbars and browser chrome.
- Markdown headings/links/tables/inline code/fenced syntax/blockquote.
- Success, pending, warning, destructive and disabled states; never color only.
- Thinking/reasoning disclosure, tool activity, model selector, source picker,
  active source chips, composer and persistent stream errors.
- Axis and pie charts, including tooltip and live theme switch.
- Reports dialog in both app themes: dialog follows app, isolated document stays
  intentionally light.

Measure representative normal text against its actual background to WCAG 2.2
AA: >=4.5:1; large text and essential control/chart boundaries >=3:1. Capture
desktop and narrow screenshots for both resolved themes as review evidence;
do not add them to the repo unless the operator asks.

**Verify**: `cd web && npm run typecheck && npm run build` -> 0 after the
manual fixes; the Tailwind literal sweep has exactly the documented scrim and
iframe hits, the CSS/JS/config literal sweep has only
`CANONICAL_CHART_PALETTE`, and the forced-theme sweep has none.

## Test plan

- No web test runner exists; do not introduce Vitest/jsdom only for this plan.
- Static gates: TypeScript/build, forced-dark search, Tailwind color-utility
  search and raw CSS/JS/config color-literal search.
- Behavioral matrix: pre-paint/no flash, persistence, System media changes,
  cross-tab storage, login/logout, keyboard menu.
- Visual matrix: every route and new composer control in both themes, desktop
  and narrow widths, syntax/status/error states.
- Canvas matrix: axis + pie/donut repaint in place without refetch and without
  changing canonical series colors.
- Accessibility: measured contrast, visible focus and text/icon status cues.

## Done criteria

- [ ] `web/index.html` has no hard-coded `class="dark"`; first paint matches the
  stored/system preference.
- [ ] Theme choice `light|dark|system` persists under `borealis_theme`, follows
  OS only in System, and synchronizes across tabs.
- [ ] Theme menu is usable before and after authentication by mouse, keyboard
  and screen reader labels.
- [ ] `rg -n 'github-dark' web/src` returns no matches; syntax highlighting is
  readable in both themes.
- [ ] Tailwind literal search contains only the modal scrim and report iframe;
  raw CSS/JS/config literal search contains only the unchanged centralized
  canonical chart palette. The SVG logo is the only out-of-command
  portable-asset allowlist.
- [ ] ModelSelector, ChatSourcePicker, chips, stream errors and every route pass
  the manual two-theme matrix.
- [ ] Axis and pie charts repaint immediately; data/series colors and values do
  not change.
- [ ] Report HTML/PDF/iframe remains fixed light and print-oriented.
- [ ] Representative contrast meets the stated AA thresholds.
- [ ] `cd web && npm run typecheck && npm run build` exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Plans 013/014/019/021/022 have not landed or their final controls differ
  materially from the prerequisite state.
- The requirement expands to themed HTML/PDF exports; split it into a persisted
  artifact-theme plan instead of coupling device preference to exports.
- Chart theming appears to require changing the canonical chart spec, stored
  ECharts rows or canonical data colors.
- Hosting CSP blocks the pre-paint inline bootstrap. Move it to an allowed local
  script under an explicit hosting decision; do not accept a theme flash.
- No live axis and pie/donut charts are available for both-theme verification.
- Any normal-text/status/control treatment fails the contrast thresholds.
- A new dependency appears necessary despite existing React, Radix and Lucide
  support.

## Maintenance notes

- New UI must use semantic tokens; add a token only when hierarchy/meaning is
  genuinely new rather than encoding a one-off color.
- Keep appearance browser-local until a real profile/settings sync exists.
- Any new canvas/SVG visualization needs an explicit resolved-theme repaint;
  CSS variables alone do not recolor pixels already rendered to canvas.
- Portable reports are documents, not app chrome. Keep their theme contract
  separate from the viewer preference.
