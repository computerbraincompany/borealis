# Plan 009: Eliminate unsolicited UI egress

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `advisor-plans/README.md` unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- web/index.html web/tailwind.config.js web/src server/src/serverApp.ts server/src/tests/serverApp.test.ts scripts/policy-check.mjs`
> Plans 030, 031, and 033 intentionally changed request ownership, paged
> catalogs, route-level lazy loading, chart loading, and bundle-budget policy
> throughout `web/src`. Those are required baseline behavior, not drift: retain
> every abort/token guard, pagination merge, lazy boundary, and offline chunk.
> Compare other changes with the excerpts and STOP only on an unrelated material
> shell-egress or CSP mismatch.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Preserve completed baseline**: Plans 030, 031, and 033
- **Category**: security
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Opening the Borealis shell currently performs DNS/TLS requests to Google before
the user has chosen any remote operation. That contradicts the local-first
privacy boundary and leaks network metadata even when all data and models are
local. Removing the remote font resources fixes the present leak. The target
state also prevents a future static shell edit from moving the same leak to
another declarative browser-fetching surface: a production-shell Content
Security Policy denies the request at runtime, while a development-time
repository policy gate rejects remote HTML, JSX/TSX, inline-style, style-block,
SVG, and tracked-CSS resources before Vite serves them without that production
header. Ordinary user-initiated anchor navigation remains valid application
content and is not treated as a shell subresource. The source gate does not
claim to prove arbitrary runtime-computed application egress; the production
CSP remains the runtime backstop.

## Current state

- `web/index.html` is the Vite shell. It directly connects to and downloads styles from two Google origins (`web/index.html:33-39`):

  ```html
  <title>Borealis</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
    rel="stylesheet"
  />
  ```

- `web/tailwind.config.js` names those unbundled families first (`web/tailwind.config.js:61-64`):

  ```js
  fontFamily: {
    sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
    mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  },
  ```

  `web/src/index.css:142-144` independently names `JetBrains Mono` for markdown code. There are no local Inter or JetBrains Mono font assets under `web/` at the planned-at commit.

- `server/src/serverApp.ts` serves production HTML with only cache policy. The static response hook at `server/src/serverApp.ts:57-62` is:

  ```ts
  setHeaders(response, filename) {
    if (path.extname(filename) === ".html") response.header("Cache-Control", "no-store");
    else if (filename.startsWith(path.join(root, "assets") + path.sep)) {
      response.header("Cache-Control", "public, max-age=31536000, immutable");
    }
  },
  ```

  The SPA fallback at `server/src/serverApp.ts:77-84` also sends `index.html` with only `Cache-Control`. There is no main-shell CSP header. Report artifacts have a separate, much stricter policy and are out of scope.

- `server/src/tests/serverApp.test.ts:76-110` is the existing structural exemplar for direct shell and SPA-fallback response headers. Extend it instead of creating a second static-host harness.

- `scripts/policy-check.mjs:72-93` provides the existing `searchFiles` helper, and the tracked-file policy gates begin at `scripts/policy-check.mjs:156`. Add the regression check there rather than inventing a new policy runner.

- The product boundary is local-first. `docs/VISION.md:253-260` says remote use is never silent, and `README.md:339-340` requires generated report HTML to work without external assets. Do not weaken any report-rendering or model-provider behavior while fixing the shell.

## Commands you will need

| Purpose               | Command                                                                                                                                                                                     | Expected on success                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Static policy         | `pnpm policy`                                                                                                                                                                               | exit 0; no external-shell-resource diagnostic                             |
| Static-host tests     | `pnpm --filter borealis-server exec vitest run src/tests/serverApp.test.ts`                                                                                                                 | all tests pass                                                            |
| Server checks         | `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`                                                               | exit 0, no errors or warnings                                             |
| Web checks            | `pnpm --filter borealis-web typecheck && pnpm --filter borealis-web test && pnpm --filter borealis-web lint && pnpm --filter borealis-web format:check && pnpm --filter borealis-web build` | exit 0; tests pass and Vite builds the shell                              |
| Final repository gate | `pnpm verify`                                                                                                                                                                               | exit 0 and prints `ALL GATES GREEN` on a fully provisioned supported host |

## Scope

**In scope** (the only source/test files to modify):

- `web/index.html`
- `web/tailwind.config.js`
- `web/src/index.css`
- `server/src/serverApp.ts`
- `server/src/tests/serverApp.test.ts`
- `scripts/policy-check.mjs`

**Out of scope** (do not touch):

- Adding npm-hosted or checked-in font binaries; the desired result uses the platform font stacks already available on every target.
- `server/src/data/reports.ts`, `server/src/data/playwrightRender.ts`, `server/src/electronRender.ts`, and `desktop/src/electronRenderer.ts`; report CSP and the Playwright/Electron renderer split are deliberate and already deny external resources.
- Model-provider, connector, and explicit `fetch_url` egress. Those are user-authorized server operations, not shell subresources.
- Refactoring the inline theme bootstrap. Its early execution prevents a theme flash; the production CSP must account for this exact existing inline script.
- Any change to API CORS behavior or the exact desktop loopback binding.

## Git workflow

- Branch: `codex/009-eliminate-unsolicited-ui-egress`
- Commit once the tests are green with: `fix(web): eliminate unsolicited shell egress`
- The repository uses conventional commit subjects (for example, `feat: set a personal default chat model in Settings`).
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Remove the remote font requests and use explicit platform stacks

Delete all three Google font/preconnect `<link>` elements from `web/index.html`. In `web/tailwind.config.js`, replace the sans stack with platform-installed families such as `system-ui`, `-apple-system`, `BlinkMacSystemFont`, and `"Segoe UI"`, followed by `sans-serif`. Replace the mono stack with `ui-monospace`, `SFMono-Regular`, `Menlo`, `Monaco`, `Consolas`, and `monospace`. Make `web/src/index.css` use the same mono stack; do not leave a reference to a font that the application no longer bundles.

**Verify**: `rg -n 'fonts\.googleapis|fonts\.gstatic|Inter|JetBrains Mono' web/index.html web/tailwind.config.js web/src/index.css` → no output and exit 1 (no matches).

### Step 2: Deny remote subresources in the production shell

Define one `STATIC_UI_CSP` constant in `server/src/serverApp.ts` and apply it to every HTML shell response: both `@fastify/static` HTML responses and the SPA fallback. The policy must default subresources to the exact Fastify origin, deny objects and embedding by other pages, and retain only the capabilities the current shell uses:

- local scripts plus the existing inline theme bootstrap;
- local/inline styles;
- local and `data:` images (chart thumbnails use PNG data URLs);
- local fonts;
- same-origin API connections;
- the existing sandboxed `srcDoc` report preview, without allowing an HTTP(S)
  frame origin.

A suitable target shape is `default-src 'self'; base-uri 'none'; object-src
'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'
'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; frame-src about:`. The absence of `'self'`
from `frame-src` is load-bearing: same-origin HTTP frames are still HTTP
network frames. Chromium permits the current `srcDoc` iframe under `about:`;
prove that behavior in a real browser rather than weakening the directive.
Keep the policy in one constant so direct and fallback HTML cannot drift. Do
not put this shell policy on JSON API responses or reuse the report artifact
CSP.

Extend `server/src/tests/serverApp.test.ts` to assert the exact
security-relevant directives on both `GET /` and an SPA navigation such as
`/reports/report-1`. Also assert that a fingerprinted JavaScript asset is still
served and that API 404 JSON does not become HTML. In the same file, use the
already-installed server Playwright dependency against a real ephemeral
`127.0.0.1` listener and a disposable shell fixture containing both a sandboxed
`srcDoc` iframe and a same-origin URL iframe. Assert that `srcDoc` renders, the
URL frame does not load, and no request for its resource reaches the server.
Close Chromium and the listener on every path; do not use the public network.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/serverApp.test.ts` → all static-host, fallback, CORS, and listener-guard tests pass.

### Step 3: Add a comprehensive tracked-source regression gate

In `scripts/policy-check.mjs`, use the existing `git ls-files` inventory to
inspect tracked `web/index.html`, every tracked `web/**/*.css` source, and every
non-test production `web/src/**/*.{ts,tsx}` file. Use the workspace's existing
TypeScript compiler API to parse TS/TSX; do not regex arbitrary source text or
add a parser dependency. Because the root workspace does not declare
TypeScript, resolve it through the web workspace with `createRequire` anchored
to the absolute `web/package.json` URL (for example,
`createRequire(new URL("../web/package.json", import.meta.url))("typescript")`),
then validate the expected compiler API before parsing. A bare root
`import("typescript")`, pnpm-store traversal, or manifest edit is forbidden.
Inspect static string/no-substitution-template JSX
resource attributes, static strings inside JSX `style` objects, and static
`<style>` children through the same classifiers as HTML/CSS. Dynamic
expressions remain governed by the production CSP. Fail with a stable,
content-free diagnostic when a resolved nonlocal target appears in any
browser-fetching shell surface:

- `src` on `script`, `img`, `iframe`, `audio`, `video`, `source`, `embed`,
  `track`, or `input[type=image]`;
- `href` on `link`, plus `href` or `xlink:href` on SVG `image`, `use`, or
  `feImage` elements;
- any candidate in `srcset` on `img` or `source`, including a mixed local and
  remote candidate list;
- `poster` on `video` or `data` on `object`;
- `href` on `base`, because a remote base makes otherwise-relative shell URLs
  remote;
- a URL target in a `meta[http-equiv=refresh]` `content` value;
- static `srcdoc` markup on an iframe. Recursively classify it with a fixed
  depth/byte budget; conservatively reject character references in that static
  markup rather than incompletely decoding an embedded document;
- CSS `@import` or `url(...)` in a tracked `.css` file, an HTML `style`
  attribute, or a `<style>` block, including quoted, unquoted, whitespace, and
  multiline spellings; and bare string or URL candidates in `image-set()` and
  `-webkit-image-set()`.

Match HTML element and attribute names case-insensitively, recognize both
quoted and unquoted attribute values, and ignore HTML/CSS comments before
classifying syntax. For `srcset`, classify every parsed candidate rather than
only the first one. For SVG, handle both ordinary `href` and the namespaced
`xlink:href` spelling. Allow relative/root-relative/fragment URLs and `data:`
assets where the corresponding production CSP allows them. In particular, do
not reject an ordinary `<a href="https://...">` navigation link: it is a
user-initiated navigation, not a shell subresource, and is the required
negative control for keeping the gate narrow.

Classify URL values by resolving them with the WHATWG URL implementation
against a fixed synthetic local origin, then compare the parsed scheme/origin
with the allowlist for that exact context. Do not rely on a literal `://`
substring: special-scheme values such as `https:example.invalid/a`,
protocol-relative values, and browser-normalized backslashes such as
`https:\\example.invalid/a` are remote. In a browser-fetching HTML/JSX value,
conservatively reject any syntactically valid HTML character reference before
resolution rather than maintaining an incomplete entity table; this blocks
numeric and named obfuscation such as `h&#116;tps://` or `https&colon;//`.
For CSS, strip comments, decode the complete CSS escape grammar (one-to-six hex
digits plus optional terminator whitespace, and escaped non-newline
characters) before locating `@import`/`url(...)`, then resolve each extracted
value through the same URL classifier. A malformed escape, character
reference, URL, `srcset`, `srcdoc`, image-set, or meta-refresh target in a fetch-bearing context
fails closed. Do not decode or reject URL-like text outside those contexts.

Also fail if the production shell no longer contains the expected CSP
attachment in `server/src/serverApp.ts`. Keep the source inventory narrow:
URLs in connector form placeholders, TypeScript/TSX tests, documentation,
explicit user links, and non-resource string literals are valid and must not be
rejected. Production TS/TSX application logic is scanned only where the AST
proves a static declarative fetch context.

Factor the HTML and CSS classification into pure local helpers and run
table-driven canaries inside the policy script before scanning the repository.
Positive HTML canaries must cover single-, double-, and unquoted attributes;
mixed casing and multiline syntax; every element/attribute family above;
`srcset` with a remote second candidate; SVG `href` and `xlink:href`; a remote
`base`; meta refresh; an inline `style` URL; and both `@import` and `url(...)`
inside a `<style>` block. Include static iframe `srcdoc` with a nested remote
image and bounded-nesting failure. Positive URL-normalization canaries must include
`https:example.invalid/a`, `https:\\example.invalid/a`, protocol-relative
syntax, numeric and named HTML references in a resource value, and a JSX
resource attribute with a remote static literal. Positive CSS canaries must
cover `@import "https://..."`, `@import url(//...)`, quoted/unquoted remote
`url(...)`, an escaped `url` token such as `u\\72l(...)`, and an escaped
scheme. Include JSX `srcSet`, style-object, and static `<style>` canaries.
Include quoted and `url(...)` `image-set` candidates with a remote non-first
candidate.
Negative canaries must cover local paths, root-relative paths, fragments,
`data:` values, HTML and CSS comments containing apparent remote resources,
ordinary CSS text, the remote anchor navigation control, a local `base`, a
non-refresh `meta`, and URL strings outside a resource attribute,
import/function, or style context. The check must fail if a positive canary is
missed or a negative canary is rejected, so a future predicate edit cannot
silently hollow out the development-time gate.

Do not print the matched URL in the diagnostic. The policy only needs to name the affected file and rule.

**Verify**: `pnpm policy` → exit 0. Then run
`rg -n '(https?:|//|src(Set)?=|url\(|@import)' web/index.html web/src web --glob '*.css' --glob '*.tsx' --glob '*.ts'`
and manually classify any result: no result may be an unapproved static
HTML/JSX resource, CSS import, or CSS URL. URL-like API/test/user-navigation
strings are expected negative controls and remain allowed.

### Step 4: Run the package and repository gates

Run the server and web check commands from the table, followed by the final repository gate. Inspect `git diff --check` and the file list; generated `web/dist/` output must remain untracked/ignored and must not be committed.

**Verify**: `git diff --check && git status --short` → no whitespace errors, and only the six in-scope files plus the executor's permitted `advisor-plans/README.md` status update are modified.

## Test plan

- Extend `server/src/tests/serverApp.test.ts` using its existing temporary static directory and `app.inject` pattern.
- Cover direct `index.html`, SPA fallback, and a non-HTML/API response so the CSP is neither missing nor over-applied.
- Keep the existing cache, dotfile, CORS, and loopback assertions passing.
- Treat `pnpm policy` and its built-in positive/negative canaries as the
  regression test for future external shell resources in HTML, production
  JSX/TSX, or CSS, including
  `srcset`, media/object attributes, SVG links, remote base URLs, meta refresh,
  inline styles, style blocks, and dev-time Vite CSS/JSX where the production
  CSP is not present. Include entity/CSS-escape/special-URL normalization
  canaries and keep an ordinary remote anchor `href` as a passing negative
  control.
- Run the complete web suite and build so removal of the named fonts does not break Tailwind generation.
- Run the deterministic local Playwright assertion on every supported test host:
  the `srcDoc` preview renders and a same-origin HTTP frame is blocked. The
  browser must make no external request.

## Done criteria

- [ ] `web/index.html` contains no remote or protocol-relative subresource URL.
- [ ] No production style stack refers to Inter or JetBrains Mono unless a future plan explicitly bundles those files locally.
- [ ] Both direct and SPA-fallback production HTML responses carry the same restrictive shell CSP.
- [ ] Chart `data:` images and the sandboxed local report preview still work; no HTTP(S) frame origin is allowed.
- [ ] A local Chromium test proves `frame-src about:` permits `srcDoc` but blocks
      a same-origin HTTP frame without requesting it.
- [ ] `pnpm policy` exits 0 and its canary-backed guard covers tracked shell HTML
      and production JSX/TSX/CSS, including every enumerated fetch-bearing
      HTML/SVG/JSX attribute,
      every `srcset` candidate, remote base and meta-refresh targets, and CSS
      `@import`/`url(...)`/`image-set(...)` in inline styles, style blocks, and
      tracked CSS during
      development. Browser-equivalent special-URL resolution plus conservative
      HTML-entity/static-`srcdoc` and complete CSS-escape handling block encoded variants; an
      ordinary remote anchor navigation remains allowed.
- [ ] Targeted server tests, all server/web checks, and `pnpm verify` pass.
- [ ] `git diff --check` passes and no file outside Scope is modified, except the allowed plan-index status update.

## STOP conditions

Stop and report back instead of improvising if:

- Any Current state excerpt no longer matches after the dependency/drift check.
- The UI now intentionally bundles local Inter or JetBrains Mono assets; report their exact tracked paths before changing the fallback strategy.
- The proposed CSP blocks Vite production chunks, same-origin `/api` calls, chart PNG data URLs, or the sandboxed `srcDoc` report preview.
- Making the preview work appears to require allowing `'self'`, arbitrary
  `http:`, `https:`, `ws:`, `file:`, or broad `data:` frame/script sources.
- Any enumerated browser-fetching surface cannot be classified without either a
  known bypass or a broad false positive, including `srcset`, SVG namespaced
  links, remote base URLs, meta refresh, inline styles, style blocks, or CSS
  resource syntax (including nested static `srcdoc` and image-set candidates)
  versus harmless text; do not silently omit the surface or
  replace the canary with a weaker substring scan.
- Static production JSX/TSX fetch attributes or style contexts cannot be parsed
  through the existing TypeScript AST without broad scanning of unrelated
  strings, or URL/entity/CSS-escape normalization differs from Chromium on a
  positive canary.
- The policy gate would need to reject URL strings in tests, user-entered connector fields, or documented examples rather than only static shell resources.
- A verification command fails twice after one reasonable correction, or the change requires a file outside Scope.

## Maintenance notes

- Review future additions to `web/index.html` or tracked CSS as network behavior,
  not merely presentation. New fonts and analytics must never arrive as silent
  third-party resources.
- Keep the HTML/JSX/CSS surface list and its positive/negative canary matrix together.
  When the shell adopts a new browser feature that can fetch during load, add
  its exact element/attribute or CSS context and a positive canary in the same
  change; do not broaden the rule to ordinary anchor navigation.
- Keep the shell CSP separate from `REPORT_CSP`; reports intentionally use a distinct, stricter self-contained-document policy.
- If the UI later needs a worker, WebSocket, or new media source, add the narrowest directive and a response-header test in the same change.
- Reviewers should inspect the actual CSP header on both the direct shell and SPA fallback, because those response paths are implemented separately.
