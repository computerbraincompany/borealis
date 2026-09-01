# Plan 022: Make server/web API contracts executable

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm its expected result before moving on. If a “STOP condition” occurs, stop and report — do not change endpoint behavior to make a schema convenient. When done, update this plan’s row in `advisor-plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- package.json server/package.json pnpm-lock.yaml server/src/auth.ts server/src/routes.ts server/src/routes server/src/openapiContract.ts server/scripts/export-openapi.mjs scripts/generate-api-contracts.mjs server/src/tests/apiContracts.test.ts server/src/tests/authRoutes.test.ts server/src/tests/agentRoutes.test.ts server/src/tests/automations.test.ts server/src/tests/connectorRoutes.test.ts server/src/tests/contained.test.ts server/src/tests/egressAudit.test.ts server/src/tests/egressConsent.test.ts server/src/tests/libraryRoutes.test.ts server/src/tests/modelRoutes.test.ts server/src/tests/preferencesRoutes.test.ts server/src/tests/reportChartRoutes.test.ts server/src/tests/settingsRoutes.test.ts server/src/tests/sourceManagementRoutes.test.ts server/src/tests/workspaceStatus.test.ts web/package.json web/.prettierrc.json web/.prettierignore web/src/lib/api.ts web/src/lib/apiContracts.generated.ts web/src/lib/api.test.ts web/src/pages/ReportsView.tsx web/src/components/ChatMessage.tsx`
> Plans 007, 010, 014, and 018 intentionally change authentication, route composition, report authorization, contained/source DTOs, and auth responses after the planned commit. Read their completed plans and compare the final live contracts before editing; generate only from that repaired behavior.
> Plans 025, 026, 028, 030, 031, 034, and 035 subsequently changed automation
> outcomes, route hooks/body budgets, chart lineage, browser request ownership,
> every resource list envelope, model qualification, Settings guards, and the
> embedding-migration route family. All are required input to this plan, not
> drift STOPs. Generate contracts from the live routes and preserve their exact
> status/error/pagination/nullable semantics; never reshape them for OpenAPI.
> **Read-only dependency check**: inspect `server/src/tests/vitestTestPartitions.ts` from plan 001; both contract suites remain in its calculated default partition. Only `apiContracts.test.ts` must remain source/document-pure and native-free; `modelRoutes.test.ts` retains its existing disposable SQLite/LanceDB lifecycle. Also confirm `web/package.json` still pins Prettier 3.4.2 and the generated target is not ignored by `web/.prettierignore`. These files/configs are not editable here.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: `advisor-plans/007-restrict-contained-engine-control.md`, `advisor-plans/010-authorize-shared-report-artifacts.md`, `advisor-plans/014-create-owned-application-runtime.md`, `advisor-plans/018-throttle-public-authentication.md`, `advisor-plans/031-paginate-resource-catalogs.md`, `advisor-plans/034-qualify-model-pairs.md`, `advisor-plans/035-manage-embedding-reindex.md`
- **Preserve completed baseline**: Plans 025, 026, 028, 030, 031, 034, and 035
- **Category**: dx
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Fastify runtime validation, the authenticated OpenAPI document, and the React client’s hundreds of handwritten interfaces currently drift independently. Most server operations do not declare response schemas, while `api<T>` trusts each caller’s cast, so a renamed/omitted field can compile on both sides and fail only in the UI. Make the server’s actual OpenAPI document complete enough to generate committed, deterministic web types, then make staleness a read-only repository-gate failure.

## Current state

- `server/src/routes/schemas.ts:1-75` contains reusable request fragments, but several are prose instead of executable unions. For example:

  ```ts
  export const sourceScopeBodySchema = {
    type: "object",
    description:
      "Exact union: {source_mode:'all'} or {source_mode:'selected',source_ids:[up to 100 UUIDs]}. Runtime validation rejects every other shape.",
    properties: {
      source_mode: { description: "Either all or selected." },
      source_ids: {
        description:
          "Required only for selected; an empty array intentionally means no sources.",
      },
    },
  } as const;
  ```

- `server/src/routes.ts:24-35` registers `@fastify/swagger` with bearer authentication as the default. `/health`, registration, and login explicitly opt out; `/api/openapi.json` is hidden and authenticated. Preserve that security model.
- `server/src/routes/chats.ts:198-240` is the rare response-schema exemplar. Its SSE success response declares `text/event-stream`, plus safe 400/403/413 JSON failures. Report HTML/PDF currently set their response content types in handlers (`server/src/routes/reports.ts:86-123`).
- Most JSON routes in `server/src/auth.ts` and `server/src/routes/{agents,audit,automations,charts,chats,connectors,consent,contained,libraries,models,preferences,reports,settings,sources,system}.ts` have request schemas at most and no success/error response contract.
- `web/src/lib/api.ts:177-199` accepts any caller-selected type:

  ```ts
  export async function api<T>(
    path: string,
    opts: RequestInit = {},
  ): Promise<T> {
    // authentication and fetch
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }
  ```

- The same file defines handwritten server representations from `Chat` onward and repeats them at each call, for example `api<Chat[]>("/api/chats")`, `api<ProviderSettingsResponse>("/api/settings")`, and `api<Report[]>("/api/reports")` (`web/src/lib/api.ts:201-1125`). Keep browser-only view types and runtime parsers, but eliminate duplicate wire-shape authority.
- `web/src/lib/api.test.ts` exercises serialization and defensive source/connector parsers. It does not prove that the server publishes the same operations/types.
- `server/src/tests/modelRoutes.test.ts:188-217` checks OpenAPI default/public security and a few path presences, but not operation IDs, response completeness, or generated-client freshness.
- Plan 007’s final contract adds the literal desktop-operator capability, redacts local paths from contained/source/library DTOs, and requires an engine-binary digest in contained configuration. Plan 014 requires explicit owned-runtime scheduler capability during route composition. Plan 018 adds the stable auth 429/`Retry-After` contract. All must appear accurately without exposing the capability as a login/register claim or making operator-only fields public.
- At the plan date, `openapi-typescript` 7.13.0 supports runtime-free OpenAPI 3.x type generation on the repository’s Node 22 baseline. Pin it exactly as a root development dependency; do not add a runtime fetch client.

## Commands you will need

| Purpose                 | Command                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Expected on success                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Add generator           | `pnpm add --save-dev --workspace-root --save-exact openapi-typescript@7.13.0`                                                                                                                                                                                                                                                                                                                                                                                                                                          | exit 0; root manifest and lockfile change, no runtime workspace dependency added                                         |
| Generate                | `pnpm contracts:generate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | exit 0; atomically writes only `web/src/lib/apiContracts.generated.ts`                                                   |
| Stale check             | `pnpm contracts:check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | exit 0 with the committed generated file byte-identical; does not write repository files                                 |
| Generated format        | `pnpm --filter borealis-web exec prettier --check src/lib/apiContracts.generated.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                   | exit 0 under web's pinned Prettier/config; generated output is not ignored                                               |
| Server contracts        | `pnpm --filter borealis-server exec vitest run src/tests/apiContracts.test.ts src/tests/modelRoutes.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                           | exit 0 in plan 001’s default/unit partition; schema/security/operation coverage passes                                   |
| Route response equality | `pnpm --filter borealis-server exec vitest run src/tests/authRoutes.test.ts src/tests/agentRoutes.test.ts src/tests/automations.test.ts src/tests/connectorRoutes.test.ts src/tests/contained.test.ts src/tests/egressAudit.test.ts src/tests/egressConsent.test.ts src/tests/libraryRoutes.test.ts src/tests/modelRoutes.test.ts src/tests/preferencesRoutes.test.ts src/tests/reportChartRoutes.test.ts src/tests/settingsRoutes.test.ts src/tests/sourceManagementRoutes.test.ts src/tests/workspaceStatus.test.ts` | exit 0; complete pre-schema status/content-type/JSON assertions remain byte-for-byte equivalent after serializers attach |
| Web tests               | `pnpm --filter borealis-web typecheck && pnpm --filter borealis-web test`                                                                                                                                                                                                                                                                                                                                                                                                                                              | exit 0; generated aliases and runtime parsers pass                                                                       |
| Style                   | `pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check && pnpm --filter borealis-web lint && pnpm --filter borealis-web format:check`                                                                                                                                                                                                                                                                                                                                                       | exit 0                                                                                                                   |
| Repository gate         | `pnpm verify`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | exit 0, contract check runs, and output ends with `ALL GATES GREEN`                                                      |

## Scope

**In scope** (the only files you should modify):

- `server/src/auth.ts`
- `server/src/routes.ts`
- `server/src/routes/schemas.ts`
- `server/src/routes/agents.ts`
- `server/src/routes/audit.ts`
- `server/src/routes/automations.ts`
- `server/src/routes/charts.ts`
- `server/src/routes/chats.ts`
- `server/src/routes/connectors.ts`
- `server/src/routes/consent.ts`
- `server/src/routes/contained.ts`
- `server/src/routes/libraries.ts`
- `server/src/routes/models.ts`
- `server/src/routes/preferences.ts`
- `server/src/routes/reports.ts`
- `server/src/routes/settings.ts`
- `server/src/routes/sources.ts`
- `server/src/routes/system.ts`
- `server/src/openapiContract.ts` (create)
- `server/scripts/export-openapi.mjs` (create)
- `scripts/generate-api-contracts.mjs` (create)
- `server/src/tests/apiContracts.test.ts` (create)
- `server/src/tests/authRoutes.test.ts`
- `server/src/tests/agentRoutes.test.ts`
- `server/src/tests/automations.test.ts`
- `server/src/tests/connectorRoutes.test.ts`
- `server/src/tests/contained.test.ts`
- `server/src/tests/egressAudit.test.ts`
- `server/src/tests/egressConsent.test.ts`
- `server/src/tests/libraryRoutes.test.ts`
- `server/src/tests/modelRoutes.test.ts`
- `server/src/tests/preferencesRoutes.test.ts`
- `server/src/tests/reportChartRoutes.test.ts`
- `server/src/tests/settingsRoutes.test.ts`
- `server/src/tests/sourceManagementRoutes.test.ts`
- `server/src/tests/workspaceStatus.test.ts`
- `web/src/lib/apiContracts.generated.ts` (create; generator-owned)
- `web/src/lib/api.ts`
- `web/src/lib/api.test.ts`
- `web/src/pages/ReportsView.tsx`
- `web/src/components/ChatMessage.tsx`
- `server/package.json`
- `package.json`
- `pnpm-lock.yaml`

`web/.prettierrc.json` and `web/.prettierignore` are read-only formatting contracts. STOP before editing either or adding another Prettier dependency/version.

**Out of scope**:

- Changing route URLs, methods, status codes, authorization, tenancy, accepted values, returned values, pagination, or error wording to fit a schema.
- Generating runtime validation for the browser or replacing defensive parsers for persisted/untrusted source and connector data.
- Generating an HTTP client, adding `openapi-fetch`, or coupling the web workspace to server source/runtime files.
- Encoding SSE event payloads as ordinary JSON, decoding report HTML/PDF in the JSON helper, or changing binary bytes/headers.
- Exposing `/api/openapi.json`, changing its authentication, or including environment/provider/storage values in generation.
- Documentation; plan 023 owns it.

## Git workflow

- Branch: `codex/022-executable-api-contracts`
- Use conventional commits; an observed example is `feat: set a personal default chat model in Settings and start new chats from it`.
- Suggested commit: `chore: generate server web API contracts`
- Commit the schemas, generator, generated file, web migration, and gate together so the branch is never intentionally stale.
- Do not push or open a PR without explicit operator instruction.

## Steps

### Step 1: Inventory the final operation matrix after every dependency

Confirm plans 007, 010, 014, 018, 025, 026, 028, 030, 031, 034, and 035 are
all `DONE`. Run their focused authorization, runtime, route, and browser tests
before documenting anything. From live route registrations and
`web/src/lib/api.ts`, build a temporary review checklist (do not commit a second
contract manifest) containing method, normalized OpenAPI path, authentication,
request schema, success statuses/content types, expected safe errors, and stable
`operationId` for every operation.

The matrix must include all JSON operations consumed by web plus `/health`, `/api/openapi.json`’s security invariant, the chat SSE operation, and report HTML/PDF artifact operations repaired by plan 010. Every operation ID must be unique, lower camel case, and describe the action (for example `listChats`, `getReportPdf`, `streamChatMessage`).

Inventory the completed second-wave contracts explicitly:

- Plan 026: all protected operations retain `onRequest` authentication and
  route-derived body ceilings; document the emitted 401/413 envelopes without
  moving hooks or inventing a larger shared limit.
- Plan 031: `GET /api/{sources,connectors,chats,reports,reports/shared,agents,libraries,automations}`
  accepts bounded `limit`/opaque `cursor` and returns
  `{ items, next_cursor }`; include `POST /api/sources/status` and
  `POST /api/connectors/status` with their bounded exact-ID request/response
  shapes.
- Plan 034: include `POST /api/models/qualify`, the complete draft Settings
  body, per-role qualification result/reason enums, draft-origin
  acknowledgment, and stable 400/403/409 failures.
- Plan 035: include `GET /api/models/embedding-migration`,
  `POST /api/models/embedding-migration/start`, and the `retry`, `cancel`, and
  `apply` mutations with exact 202/status/phase/capability fields and stable
  400/403/404/409/413/507 failures. Include Settings'
  `embedding_dimension` and `EMBEDDING_REINDEX_REQUIRED` response.
- Plan 028: chart registry/detail schemas preserve nullable owning `run_id` and
  `chat_id` without exposing spec/PNG bytes in registry JSON.
- Plan 025: automation history status includes the existing `skipped` outcome;
  cancellation's fixed detail remains ordinary emitted data, not a new public
  error type.

**Verify**:
`rg -n '\b(api(?:<|\()|apiText\(|apiBlob\(|openProtected\(|streamAgentChat\(|fetch\()' web/src --glob '*.ts' --glob '*.tsx'`
plus
`rg -n 'app\.(get|post|put|patch|delete)\(' server/src/auth.ts server/src/routes.ts server/src/routes`
→ every JSON, multipart, SSE, HTML, and PDF client operation has one live
route and every web-consumed live route is in the checklist; all five live HTTP
verb registrations and plan 010 report artifacts are represented.

### Step 2: Make request and JSON response schemas complete without changing behavior

Turn prose-only request unions in `server/src/routes/schemas.ts` into exact JSON Schema (`oneOf`, required fields, bounds, enums, `additionalProperties`) that mirrors existing runtime validators. Add reusable component schemas for identifiers, timestamps, safe errors, sources, chats/messages/runs, models/settings/preferences/status/consent, agents/libraries, connectors/schedules/syncs, reports/shares, charts, automations/runs, audit events, accounts, and contained-engine/download state.

Give every reusable schema a stable `$id` exactly equal to its public OpenAPI
component key. Export one fixed tuple and `registerApiSchemas(app)` from
`schemas.ts`; after Swagger registration and before the first route, call
`app.addSchema` exactly once per tuple entry. Route request/response schemas use
Fastify-owned `$ref` values to those registrations, and Swagger must publish
the same entries under `components.schemas`. Do not maintain a second
postprocessor-only component copy. Add document assertions for the exact fixed
component-key set and require every `$ref` to resolve.

Give every route a stable `operationId` and declare every actual JSON success/error response. Use required/nullable semantics matching emitted payloads — never mark a field optional merely to make existing fixtures compile. Keep global bearer security and the exact public overrides. Include plan 018’s 429 body/header semantics, plan 007’s redacted contained/source/library responses and binary-digest config request, and plan 010’s owner/shared report artifact access. The desktop-operator JWT claim is internal authorization state, not part of register/login response schemas.

For the Plan 031 catalogs, register one generic page shape only if generated
item types remain exact per operation; `next_cursor` is required and nullable,
never optional, and cursor contents remain opaque strings. Do not restore array
responses or expose decoded ordering tuples. For Plans 034/035, reuse the live
qualification/migration schemas and exact reason/phase enums rather than
maintaining a second approximation. For Plan 026, preserve route-level
`bodyLimit` and `onRequest` configuration while adding schemas; OpenAPI metadata
does not authorize moving those runtime controls into validation.

Fastify response schemas can serialize away undeclared fields. Before attaching
each response schema, add an exact expected status, content type, and complete
JSON value to that route's owning in-scope test; derive nondeterministic IDs and
timestamps from the seeded record rather than loosening equality. Run that
assertion against the pre-schema handler, attach the schema, then rerun the
unchanged assertion. If schema attachment alters bytes, status, headers, or
fields, STOP and report the mismatch instead of broadening the schema
speculatively.

For SSE, HTML, and PDF, retain raw handlers/bytes. Create `server/src/openapiContract.ts` with a pure, fixed postprocessor that adds only operation metadata/status/content schemas for these non-JSON bodies to the Swagger document; it must not install a Fastify serializer. Apply the same postprocessor to authenticated `/api/openapi.json` and the exporter. Assert SSE is `text/event-stream`, HTML is `text/html`, and PDF is `application/pdf`; their web result type is `Response`/text/blob metadata, never a JSON interface.

Treat `POST /api/sources/upload` as the fourth document-only exception. Add its
required `multipart/form-data` request body in the fixed postprocessor with one
required `file` property of `type: "string", format: "binary"`, while its JSON
responses still use registered schemas. Do **not** attach a Fastify body schema
to this route: a normal JSON serializer/validator can consume or reject the
stream before `req.file()` and change behavior. Assert the postprocessed
operation has exact multipart metadata and the live upload parser remains
unchanged.

**Verify**: at this step run only the Route response equality command. Every
owning suite must exit 0 before and after its schema attachment. The isolated
exporter does not exist yet, so `apiContracts.test.ts` is created and run in
Step 3 rather than referenced prematurely.

### Step 3: Build deterministic source-only generation

Add exact root dev dependency `openapi-typescript@7.13.0`. Create
`server/scripts/export-openapi.mjs`, run through the server workspace’s existing
`tsx` loader. It must instantiate Fastify without listening and compile against
Plan 014's exported route-options type. Construct the exact final equivalent of
an explicit browser-mode/stopped-scheduler options object plus inert injected
Plan 034/035 Settings, qualification, and embedding-migration capabilities,
using `satisfies RoutesOptions`, then call `routes(app, options)`. Use the final
property names from Plan 014. No option may be omitted/defaulted and no
`ApplicationRuntime`, global runner, provider client, migration coordinator, or
storage/settings singleton may be constructed. Await readiness,
obtain and postprocess `app.swagger()`, write only canonical JSON to stdout, and
close in `finally`. It must not open SQLite/LanceDB/DuckDB, load operator
settings/provider state, construct the model client, start schedulers/workers,
or create the application runtime. The same explicit route options must already
be present in `modelRoutes.test.ts`; missing Plan 014 composition is a drift
STOP, not permission to restore a default/global. The only permitted
initialization side effects are `config.ts`'s unavoidable directory/signing-
secret setup, confined to the generator's disposable data root described below.

Create `scripts/generate-api-contracts.mjs`. It must:

- create one mode-0700 temporary outer directory with separate empty `cwd/` and `data/` children before spawning the exporter, generate a strong synthetic JWT signing value in memory, and construct a fixed child environment that points `BOREALIS_DATA_DIR` at `data/`, sets loopback/OS-assigned bind defaults, passes the synthetic `JWT_SECRET`, and removes every inherited Borealis/model/provider/key/path override;
- run the child with its working directory set to the fresh `cwd/`; resolve repository scripts, target files, pnpm/package binaries, and imports from `import.meta.url`/validated absolute repository paths rather than `process.cwd()`;
- preserve only the minimum process-launch variables required for Node/pnpm, never print the synthetic signing value or temporary path, and recursively remove the temporary root in `finally` on success, exporter failure, parse failure, or timeout;
- reject stderr, nonzero exit, malformed/non-OpenAPI JSON, duplicate/missing operation IDs, or any server URL/security value derived from the host environment;
- import the 7.13.0 Node API exactly as `import openapiTS, { astToString } from "openapi-typescript"`; call `await openapiTS(document, deterministicOptions)` to obtain its TypeScript AST, then pass that AST to `astToString`. Never template-interpolate, concatenate, JSON-serialize, or call `String(...)` on the AST nodes;
- normalize the `astToString` result to LF line endings and exactly one trailing newline, then prepend the fixed generated-file warning/command (also LF-only, with no timestamp or absolute path);
- resolve/import the web workspace's already-pinned Prettier 3.4.2 with
  `createRequire` anchored at the absolute `web/package.json` URL (never a bare
  root import or pnpm-store traversal), load the exact options from
  `web/.prettierrc.json`, and call its programmatic `format` in memory on the
  complete preamble-plus-generated source with `filepath` set to the absolute
  `web/src/lib/apiContracts.generated.ts` target. Normalize the formatted
  result to LF and one trailing newline before hashing, comparing, or writing.
  Do not add another Prettier dependency, ignore the generated file, shell out
  to a write-mode formatter, or write any repository file in `--check`;
- support exactly `--write` and `--check`;
- in `--write`, write a sibling temporary file and atomically rename it to `web/src/lib/apiContracts.generated.ts`;
- in `--check`, compare entirely in memory and emit one fixed stale-file message/nonzero exit without modifying the repository.

The child environment and isolated working directory must exist before Node imports `config.ts`; otherwise importing `routes` can create a default `.borealis` directory and signing-secret file in its current directory. After each child exits, prove its isolated `cwd/` remains empty (including no `.borealis`, settings, or secret artifact); all allowed config side effects are contained under the disposable `data/` root. Each generator invocation owns exactly one fresh outer root and synthetic in-memory signing value and removes that root in `finally`; the determinism regression invokes the generator twice, so those two invocations necessarily use distinct roots/values. Never inspect, stat, delete, or otherwise change the repository’s existing ignored `.borealis` or any operator data.

Add root `contracts:generate` and `contracts:check` scripts that call the root generator directly; do not add redundant server-package aliases. Add `contracts:check` before Turborepo work in root `verify`. Extend both server `format` and `format:check` globs to cover `scripts/export-openapi.mjs` and `../scripts/generate-api-contracts.mjs` using the server workspace's existing Prettier dependency; do not leave either script outside the ordinary deterministic format gate.

Now create the initial `server/src/tests/apiContracts.test.ts` subprocess suite.
Keep the Vitest process source/document-pure: it must invoke only the isolated
exporter/generator child, never statically import routes/config/native stores.
At this step prove exporter success, isolated-root cleanup, exact registered
component keys/resolvable refs, route-option independence, multipart upload
metadata, and non-JSON content metadata. Step 5 extends this same suite with the
full coverage/staleness matrix.

**Verify**:
`pnpm contracts:generate && first_contract_hash=$(shasum -a 256 web/src/lib/apiContracts.generated.ts | awk '{print $1}') && pnpm contracts:generate && second_contract_hash=$(shasum -a 256 web/src/lib/apiContracts.generated.ts | awk '{print $1}') && test "$first_contract_hash" = "$second_contract_hash" && pnpm contracts:check && pnpm --filter borealis-web exec prettier --check src/lib/apiContracts.generated.ts && pnpm --filter borealis-server exec vitest run src/tests/apiContracts.test.ts`
→ the command itself asserts identical hashes, check exits 0 without
writing, the generated file passes the web workspace's existing format gate,
and the pure initial document suite passes. Review `git status --short`:
repeated generation changed only the one generated file once.

### Step 4: Derive the web client’s wire types from generated operations

Import generated `paths`, `components`, and `operations` as types in `web/src/lib/api.ts`. Replace handwritten wire interfaces with aliases such as `components["schemas"]["Chat"]`; retain only UI-local/computed types. For each client method, derive request body/query/path parameters and success response from its exact generated operation ID rather than writing `api<SomeType>` independently.

A small local type helper may map an `operations` entry to JSON request/response types, but it must not cast `unknown` into a different operation. Keep `api` internal and untrusted at runtime. Preserve `parseSourceListPayload`, connector/schedule/sync parsers, and any other defensive normalizer; type their successful result with generated aliases only after validation.

Keep explicit non-JSON helpers for chat SSE and report artifact fetches. Their operation metadata must derive from the generated operation while their bodies remain stream/text/blob handling.

Keep Plan 031 page requests/results operation-bound: exported list clients take
generated `limit`/`cursor` query types and return generated
`{ items, next_cursor }`, while the existing defensive parsers/merge helpers
retain deduplication and cursor validation. Keep Plan 030 request ownership:
API helpers continue accepting `AbortSignal`, and migrating report/share or
other secondary-dialog call sites may not remove their request token,
target-capture, close invalidation, or abort behavior just because generated
types now exist.

Keep upload's runtime adapter local and explicit: accept a browser `File`, build
`FormData`, and append under a literal key that
`"file" satisfies keyof` the generated `uploadSource` multipart body type.
Derive path/status/JSON response from `operations["uploadSource"]`; never cast
`FormData` itself to the generated object schema or send JSON.

Remove exported arbitrary-path `apiText(path)`, `apiBlob(path)`, and
`openProtected(kind, path, ...)` authority. Replace them with report-operation-
bound wrappers that accept a typed `reportId` (and a closed HTML/PDF kind only
where one wrapper is shared), derive path parameters and response metadata from
`getReportHtml`/`getReportPdf`, and construct only those two fixed route
templates. Update `ReportsView.tsx` and `ChatMessage.tsx` call sites. Keep
`streamAgentChat` bound specifically to `streamChatMessage`; it may not accept
an arbitrary fetch path. This preserves text/blob/stream handling while making
every exported client method derive from one exact generated operation.

Delete handwritten duplicates only after all call sites compile. Do not edit the generated file manually.

**Verify**: `pnpm --filter borealis-web typecheck && pnpm --filter borealis-web test` → exit 0; every exported API method uses a generated operation/body/response type, and runtime parser/serialization tests remain green.

### Step 5: Make drift and coverage fail the normal gate

Extend the pure `server/src/tests/apiContracts.test.ts` document test created in
Step 3 in plan 001’s default unit partition; do not statically import `routes`,
`config.ts`, storage modules, or native stores in that Vitest process. Exercise
the isolated exporter/generator subprocess so its environment exists before
those imports. `modelRoutes.test.ts` also remains in the calculated default
partition but intentionally retains its existing disposable native-storage
lifecycle. Do not add either file to the serialized integration manifest.
Cover:

- every non-hidden route has a unique operation ID;
- all web-consumed JSON operations have executable request and success-response schemas;
- expected 4xx/429 responses remain represented where handlers emit them;
- every protected route still reports an `onRequest` auth hook and its exact
  route-owned body limit where applicable; representative unauthenticated
  oversized requests remain 401-before-parse and authenticated oversized
  requests remain the stable 413 envelope in the existing Plan 026 suite;
- public operations are exactly `/health`, register, and login; `/api/openapi.json` remains authenticated and hidden;
- plan-010 shared report detail/HTML/PDF access is documented correctly;
- all eight Plan 031 paged catalogs and two bulk status operations have exact
  query/body/page contracts; qualification and every embedding-migration
  operation are present with their live errors and enums; chart lineage and
  automation `skipped` history fields are present;
- non-JSON content types are present without a response serializer;
- exact registered component keys and resolvable `$ref` values, plus the
  document-only multipart upload request body with no live body serializer;
- document generation succeeds twice from distinct empty temporary working directories with separate 0700 data roots and synthetic in-memory signing values, produces identical content-free output, and leaves each temporary working directory empty;
- every operation type used by `web/src/lib/api.ts` exists in the generated document.

Add a web compile-time fixture in `api.test.ts` (using `satisfies`/type-only assertions, not `any`) proving representative request and response field drift fails TypeScript. Runtime tests still cover outgoing JSON serialization and untrusted payload degradation.

**Verify partition membership**:

- `pnpm --filter borealis-server exec vitest list --filesOnly | rg 'src/tests/(apiContracts|modelRoutes)\.test\.ts'` → exactly both file paths are listed once.
- `pnpm --filter borealis-server exec vitest list --filesOnly --config vitest.integration.config.ts | rg 'src/tests/(apiContracts|modelRoutes)\.test\.ts'` → exit 1 with no matches; neither file is in the serialized manifest.

**Verify**: `pnpm contracts:check && pnpm --filter borealis-server exec vitest run src/tests/apiContracts.test.ts src/tests/modelRoutes.test.ts && pnpm --filter borealis-web typecheck && pnpm --filter borealis-web test` → all pass; the generated file is current and both contract suites appear in the default test list, not the serialized integration list.

### Step 6: Run complete gates and inspect scope

Run formatting/linting before the full repository gate. The contract check must run as part of, not merely before, `pnpm verify`.

**Verify**: `pnpm contracts:check && pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check && pnpm --filter borealis-web typecheck && pnpm --filter borealis-web test && pnpm --filter borealis-web lint && pnpm --filter borealis-web format:check && pnpm verify` → exit 0; final output is `ALL GATES GREEN` and `git status --short` lists only in-scope files plus the optional index row.

## Test plan

- New server contract suite: operation completeness/uniqueness, exact auth,
  component/ref resolution, multipart/non-JSON metadata, deterministic export,
  and plan-010 report-artifact behavior.
- Existing in-scope route suites: unchanged complete JSON values,
  status/content-type/headers after response schemas are attached.
- Web `api.test.ts`: generated request/response aliases, JSON and
  File-to-FormData serialization, defensive untrusted-payload parsing, and
  operation-bound SSE/report blob/text separation with no arbitrary-path helper.
- Generator check: two writes are byte-identical; `--check` is read-only and rejects a stale file.
- Formatting check: in-memory generation uses web's pinned Prettier/config/output filepath, and the committed generated file is included in `web format:check` rather than ignored.
- Full gate: committed generated output is mandatory for typecheck/build and checked by `pnpm verify`.

## Done criteria

- [ ] Every web-consumed JSON operation has one unique operation ID plus exact request and success/error response schemas.
- [ ] Plans 026/031/034/035 are complete in the generated contract: early-auth
      runtime tests/body budgets stay intact; all catalog/status, qualification,
      and embedding-migration operations and errors are represented exactly.
- [ ] Plan 028 chart lineage and Plan 025 automation terminal outcomes remain in
      generated response types, while Plan 030 abort/token ownership remains in
      the browser call sites.
- [ ] Reusable schemas have fixed `$id` component keys, are registered once in
      Fastify before routes, and every published `$ref` resolves to that same
      registry rather than a duplicate postprocessor copy.
- [ ] Global bearer security, the three public operations, and authenticated hidden OpenAPI behavior are unchanged.
- [ ] SSE/HTML/PDF bytes and handlers are unchanged while their content metadata is present in the final document.
- [ ] Source upload keeps its live multipart parser, has document-only binary
      `file` metadata, and the web File-to-FormData adapter derives its response
      and field name from `uploadSource` without pretending FormData is JSON.
- [ ] `web/src/lib/apiContracts.generated.ts` is deterministic, generator-owned, and current.
- [ ] The complete generated source is formatted in memory with web's pinned Prettier and `.prettierrc.json`; it passes the ordinary web format check with no generated-file ignore or extra Prettier dependency.
- [ ] Web wire aliases and method request/response types derive from generated operations; runtime parsers remain.
- [ ] Report and chat non-JSON helpers are bound to exact generated operations;
      no exported arbitrary path can select text/blob/stream behavior.
- [ ] `pnpm contracts:check` is read-only and runs inside `pnpm verify`.
- [ ] Every exporter child starts from an empty isolated working directory, confines config side effects to a separate disposable data root, leaves its working directory empty, and never inspects/changes repository or operator `.borealis` state.
- [ ] `openapi-typescript` is an exact root dev dependency only; no runtime client or workspace link was added.
- [ ] The source/document-pure contract suite and native-lifecycle model-route
      suite each remain exactly once in plan 001’s calculated default partition;
      neither silently disappears behind the integration config.
- [ ] All focused and full gates pass with `ALL GATES GREEN`.
- [ ] Only in-scope files plus the optional index row are modified; plan 022 is marked `DONE` unless the reviewer owns the index.

## STOP conditions

Stop and report if:

- Any predecessor (007, 010, 014, or 018) is not `DONE`, or its final capability/redaction/runtime/report/auth-throttle contract differs.
- Any completed baseline plan (025, 026, 028, 030, 031, 034, or 035) is absent
  from the live routes/client, or representing it would require reverting its
  pagination, hook/body-limit, request-ownership, qualification, migration, or
  lineage contract.
- A response schema strips/adds fields, changes bytes/headers/status, or requires changing a handler/client contract.
- An accepted request cannot be represented exactly in JSON Schema without changing validation behavior.
- Generating the document requires opening a socket, opening any storage engine, loading operator settings/provider state, constructing application runtime, reading environment-managed credentials, or contacting a provider; the only allowed initialization is `config.ts`'s disposable-root setup already specified in Step 3.
- Importing `routes` creates anything in the isolated child working directory, escapes the disposable data root, or requires inspecting/changing repository/operator `.borealis`, settings, or signing-secret state.
- Output differs across two identical runs or across irrelevant provider/storage environment values.
- Non-JSON metadata cannot be added without installing a response serializer on SSE/HTML/PDF.
- The generated client would require a runtime dependency, importing server source into web, or workspace-linking the server.
- `apiContracts.test.ts` cannot remain in the default partition without
  statically importing routes/config or opening native storage; report evidence
  before reclassifying it. `modelRoutes.test.ts`'s existing isolated native
  lifecycle is not a reason to call both suites pure or move either one.
- A required fix is outside scope, lockfile changes are unrelated, or a verification fails twice after one reasonable correction.

## Maintenance notes

- Change the route schema and operation ID first, run `pnpm contracts:generate`, then update web call sites. Never hand-edit the generated file.
- Operation IDs are now source compatibility for the web client; rename them only with generated/client changes in the same commit.
- Static generation must remain offline and configuration-independent. A route whose schema depends on runtime state is a design regression.
- Keep runtime parsers where persisted or untrusted JSON can be malformed; generated TypeScript is not runtime validation.
- Plan 023 must document the generate/check commands and API behavior after every remediation, but should not duplicate generated schemas manually.
