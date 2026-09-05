# Product Vision: Borealis

_The local data-intelligence platform._

Current-product inventory reviewed against `e2e6a78` on 2026-09-06. The
[milestone roadmap](../milestones/README.md#selected-functional-wave)
separates recommended next work from completed and already planned slices.

Borealis is the northern lights of private AI: a local, open-source workspace
that treats an organization’s files, tables, and reports as first-class
intelligence — not as attachments to a chatbot.

It should feel as cool and inevitable as a personal local-agent computer.
It should work as seriously as an enterprise knowledge platform.
It should never require a vendor cloud to think.

---

## The promise

**Open a sleek desktop app. Point it at your data. Talk to it. Get evidence,
charts, and artifacts you can keep. The models stay on machines you own.**

That is the whole product.

Most AI software asks you to upload work into someone else’s cluster and hope
the policy page is honest. Most “local LLM” software asks you to become the
platform: pick a runtime, wire retrieval, invent SQL, export a PDF, and never
quite get a product. Borealis occupies the gap between those failures.

It is a **local Cohere North**: the B2B data-intelligence surface — sources,
grounded chat, analysis, durable reports — running as an Electron application
on hardware you control. Models may live inside the app on a capable Mac. More
often they live one hop away, on a desk-side DGX Spark or a small cluster
behind an OpenAI-compatible proxy. Either way, the product is the workspace,
not the weights.

---

## Why this exists

Two products, captured in our research archives, define the space we are
claiming. Neither is the specification of Borealis. Both are the reason the
claim is worth making.

**Cohere North** is the category we want to occupy. At capture it was not
document chat. It was a governed enterprise agentic platform: Chat, Agents,
Sources and Libraries, Tools and MCP, Documents, Tables, Deep Research,
Automations, Memory, and a separate administration plane. The competitive unit
was a complete application — retrieval, reusable agents, inspectable citations,
durable artifacts, workflows with human review, and private deployment —
not a model and not a prompt box.

North’s lead differentiator was data control: on-premises, VPC, and
air-gapped installation as product, not paperwork. Its users were operators
of knowledge, not hobbyists of inference. That is the B2B gravity we want.

**Perplexity Portable Computer** is the feeling we want people to have when
they launch us. The public launch framed a local-first agent stack: models,
orchestrator, task state, and search on the user’s machine by default;
web, connectors, and frontier advisors only after an explicit gate. The
interface grammar was unapologetically local — a “you are working locally”
state, task progress, hardware presence, file-and-page citations, consent
cards before anything left the device, and receipts when work returned.

Portable Computer launched as Linux software for NVIDIA DGX Spark. Its public
positioning emphasizes a general local _computer_: files, code, research,
connectors, and sandboxed actions. Borealis's intended distinction is a sharper
focus on tabular analysis, inspectable evidence, and reusable business artifacts.
That is our product bet, not a claim that Portable Computer cannot analyze data
or produce reports. The dated [functional comparison](PRODUCT_REVIEW.md)
separates current public vendor claims from archived research.

Borealis takes North’s job and Portable Computer’s presence, then refuses
both vendors’ locks: no Kubernetes tax to get started, no subscription to
think, no requirement that the laptop _be_ the GPU.

---

## What Borealis is today

This section is inventory, not apology. The vision is only honest if it
starts from the shipping product.

Borealis is already a working **agentic data workspace** for Apple Silicon
macOS 13+, with a browser-development path for contributors. The desktop
build is an Electron shell that starts the Fastify backend on loopback,
serves the React UI from that exact origin, and creates a local account so
the happy path is register-free.

The durable core is deliberately split by job:

| Store      | Job                                                                        |
| ---------- | -------------------------------------------------------------------------- |
| SQLite     | Relational ledger and chunk text                                           |
| LanceDB    | Account- and source-scoped embedding vectors                               |
| DuckDB     | Bounded analytical SQL over user tabular files                             |
| Filesystem | Uploads, reports, provider/contained settings, model files, signing secret |

People upload CSV, TSV, XLSX, Parquet, JSON, JSONL, PDF, DOCX, and plain
text, or pull public CSV/JSON URLs through connectors. Image-only PDF pages
can use bounded local macOS Vision OCR without a network fallback. They attach a
deliberate source scope to a chat. The agent can retrieve passages, list
sources, query and describe tables, render charts, create HTML/PDF reports,
and fetch a public URL the user wrote in the current turn. Answers can carry
numbered, clickable citations into retrieved evidence, chart cards, and saved
query previews. Reports are self-contained, versioned, linked by supersession,
renamable, and backed by a durable chart registry; renderers are
deny-by-default.

Model calls already go to an OpenAI-compatible endpoint. The default is
loopback LM Studio. Settings persist the origin, optional key, and chat /
embedding model IDs and dimension, qualify a draft pair with fixed synthetic
tool/embedding calls, and manage a separate-index embedding migration with
verified live activation after draining active turns, without restarting the
app or mixing retrieval identities. Each account may choose a personal default
chat model. Contained mode can download and SHA-256-verify a model file, manage an
operator-supplied `llama-server` on loopback, switch the live provider to it,
and restore the previous origin on stop. The app still does not bundle an
engine binary or model weights. Provider origins require HTTPS except for
validated loopback and `.local` hostnames, which may use HTTP. Parsing, SQL,
storage, and rendering stay on the machine. Ingestion text, retrieval queries,
prompts, chat history, and selected
source/tool context follow whichever provider is configured. The normal
payload-bearing entry points are fail-closed until the account acknowledges
remote egress; the consent UI names the current destination and payload classes,
but the acknowledgment is per account rather than per host. The UI keeps the
boundary ambient after consent. Scheduled connector execution rechecks the account’s remote-egress consent
before synchronization, as completed in M07. Provider-bound acknowledgment is
still planned remediation; current acknowledgment remains account-wide.

The current surfaces are Chat, Sources, Libraries, Agents, Automations,
Connectors, Reports, and Settings. Libraries are account-scoped source
collections that expand into an explicit chat scope. Named agents have configurable identity, versioned system prompts, reusable
Markdown skills, and built-in tool allowlists. They bind at chat creation; the
next message uses the latest configuration, while active messages keep their
snapshot. Selections can restrict tools but never widen source scope or account
authorization. MCP connections and OAuth remain planned. Reports can be shared read-only with sibling accounts
on the same instance. Interval automations run connector refreshes and agent
turns; agent turns reuse the normal consent and run gates, and scheduled connector refreshes recheck the same consent gate. Settings exposes a
best-effort, content-free activity log for selected remote-capable attempts,
not proof of completed network egress.

Operators can also create encrypted, integrity-verified portable workspace
archives while Borealis is stopped. Restore is an offline, recoverable operation
that verifies SQLite, LanceDB, and ready tabular sources together and preserves
the old target until the operator explicitly removes it. This remains an
instance-wide operator surface, never an account API.

That is already a local data platform in miniature, not merely a document-chat
prototype. The remaining distance is depth: standalone artifact kinds beyond
reports and charts, plus promotion of query receipts beyond chat metadata;
richer review and governance than same-instance snapshot sharing; a contained
runtime that does not require operator assembly; and the same product finish
across every workflow. Multi-step automation graphs, public sharing, arbitrary
code execution, and other desktop targets remain outside the shipping surface.

---

## The product we are becoming

Borealis is a **local data-intelligence platform** you run as a desktop
application.

_Local_ means the control plane, the data plane, and the default compute
plane are machines the operator owns. The Mac on the table is the product.
The Spark under the desk, or the rack down the hall, is optional muscle.
A public API is an escape hatch with a visible cost, never the assumed
home of the corpus.

_Data intelligence_ means the unit of value is not a clever reply. It is
a cited answer over _this_ library, a SQL-backed number over _these_
tables, a chart that can be regenerated, and a report a human can send.
Conversation is the way in. The durable objects — sources, generations,
queries, charts, documents — are the product.

_Platform_ means the same workspace can grow from a single analyst’s
laptop to a small team’s shared brain without changing genre: still an
app, still private, still inspectable. Agents, libraries, and automations
are layers on that substrate, not a second company.

### The object you open

Borealis should feel like a precision instrument that happens to speak.

Launch is instant and silent. There is no account wall on the desktop
path. The first screen is a composer and a library, not a setup wizard
disguised as a product. Locality is visible: you can see whether inference
is on this Mac, on the office cluster, or — if you chose it — on a remote
provider. Hardware and model health are ambient, like a good DAW shows
buffer and sample rate. When something would leave the trust boundary,
the app stops and asks, with the exact destination and the exact payload
class, then returns the result to the same task.

The visual register is closer to a high-end local workstation than to an
enterprise portal. Quiet density. Dark glass and paper light. Typography
that can carry a financial narrative. Motion that reports progress instead
of performing intelligence. North’s seriousness without North’s cockpit.
Portable Computer’s cool without Portable Computer’s consumer-agent
theater.

### The work it is for

A controller drops four CSVs and asks for the quarter. A diligence
associate grounds a memo in a data room. A founder keeps the company’s
operating brain on a MacBook that talks to the office Spark. A research
pod indexes a corpus that must not become someone else’s training set.
An operator on a classified or air-gapped network still gets an agent,
because the platform never assumed the public internet.

In every case the loop is the same:

1. **Collect** — files and connectors become sources with generations,
   readiness, and ownership.
2. **Ground** — retrieval and SQL are scoped to an explicit snapshot,
   never to “whatever the model felt like reading.”
3. **Analyze** — the agent uses tools; the user sees sanitized activity,
   not chain-of-thought theater.
4. **Keep** — charts, query receipts, and reports persist as artifacts
   with lineage, not as chat decoration.
5. **Share** — reports already move between sibling accounts as read-only
   snapshots. Every broader sharing path remains a snapshot with a policy,
   not a paste into the public web.

### The intelligence it grows

Today the agent is one streaming tool loop. The destination is a platform
of _reusable intelligence_ over the same local stores:

- **Personal agent** — the default workspace brain: model, source habits,
  and capabilities that belong to you.
- **Named agents** — versioned instructions, tools, and source bindings
  for a job: “finance analyst,” “diligence,” “ops brief.” They do not
  grant data the runner cannot already see.
- **Libraries** — governed collections above a pile of uploads. A library
  is something you attach, share inside a trust boundary, and cite.
- **Artifacts** — documents, tables, charts, and reports with versions
  and provenance. Chat creates them; it does not trap them.
- **Automations** — durable scheduled work with tests and human review.
  Today’s interval-based connector refresh and agent-turn digests are the
  smallest earned slice. Multi-step workflows come only after their artifact
  and evidence substrate is real; a graph builder on top of an empty platform
  is North cosplay.

We will not clone North’s taxonomy for its own sake. We will take the
jobs that made North a platform — grounded work, reusable agents, durable
outputs, inspectable action — and implement them in a local-first
application.

---

## Model topology

Borealis is model-agnostic by architecture and opinionated by default.

The product speaks OpenAI-compatible HTTP. That is the only public
inference contract. Everything else is a way to satisfy it.

```text
┌──────────────────── Borealis.app ─────────────────────┐
│  Electron shell · local API · SQLite · LanceDB · DuckDB │
│  Composer · libraries · artifacts · locality · consent  │
└───────────────┬───────────────────┬───────────────────┘
                │                   │
     contained models        linked compute
     (same Mac)              (your LAN / cluster)
     managed llama-server    compatible proxy · vLLM · LM Studio
     verified model files    DGX Spark · workstation GPU
                │                   │
                └─────────┬─────────┘
                          │
                 optional remote
                 HTTPS OpenAI-compatible
                 provider · visible egress
```

**Contained.** On macOS this is the elegant path. Apple Silicon can host
a strong chat model and a dedicated embedding model on the same machine
as the UI. Borealis already downloads and verifies model files, manages an
operator-supplied `llama-server`, and owns its loopback lifecycle — the first
Portable Computer move. It does not yet bundle that engine or a curated model,
so installation still asks the operator to assemble the final pieces. The
destination is a first-class contained personality: offline-capable, zero
token meter, slightly smaller models, and honest about what they cannot do.

**Linked.** This is the typical professional topology and the one we
optimize the Settings story for. The app runs on a MacBook. Inference
runs on a local DGX Spark, a desk-side workstation, or a small cluster,
usually behind LiteLLM or another OpenAI-compatible proxy. The laptop
stays the control plane and the data plane. The cluster stays
replaceable muscle. Borealis already behaves this way: a bare origin,
`/v1` appended by us, chat and embed as distinct identities. We will
make that feel like plugging a studio monitor into a console, not like
pasting a URL into a developer form.

**Remote.** A hosted OpenAI-compatible API remains valid. It is never
silent. The privacy boundary is already true and must stay productized:
when a remote provider is configured, upload and ingestion text, prompts,
chat history, retrieval queries, and selected tool context leave the machine
under that provider’s policy. A source need not be attached to a chat for its
ingestion text to be sent. Parsing, DuckDB, stores, and rendering remain local.
Remote is a consent-gated choice with a standing badge, not a default that
forgot to speak.

Three rules will not move:

1. **The model proposes; the workspace decides.** Tools, SQL, retrieval
   scope, filesystem, and egress are server policy, not model authority.
2. **Chat and embedding stay distinct.** Mixing them is how retrieval
   rots.
3. **Changing the embedding model is a data event.** Same- or
   different-dimension changes build and verify a separate index, then perform
   a journaled live swap after active turns drain; startup recovers interrupted
   swaps. They are never an in-place Settings toggle.

---

## Principles

**Local by default, not local-only.** Data, indexes, runs, and artifacts
live on the operator’s machines. Outside-world steps are explicit, gated,
and returned to the same task.

**The corpus is the product.** If we cannot ingest it, scope it, cite it,
query it, and keep an artifact from it, we do not claim to understand it.

**Desktop is the system of record for the feeling.** Browser development
is for contributors. The object we are designing is an Electron
application on a desk — first Apple Silicon macOS, then other desktops
only when their security story is real.

**Taste is a feature.** Density without clutter. Status without dashboards
for their own sake. Progress that looks like work. No mascot, no purple
haze, no fake tokens streaming through a thought bubble.

**Inspectable work.** Citations, tool summaries, query receipts, report
lineage, and model locality are user-visible. Hidden reasoning and raw
provider payloads are not.

**Fail closed.** Selected-empty means none. A broken sandbox, an
unresolved path, or an unknown renderer target does not “try anyway.”
SQL is one read-only statement. Retrieval joins vectors back to text
under the same account and source scope or the hit disappears.

**Open, not derivative.** Borealis is MIT-licensed and independently
designed. North and Portable Computer are research inputs. We will not
copy trade dress, prompts, schemas, or checklists from either archive
into the product.

**Earn platform features.** Agents before automations. Artifacts before
sharing. Libraries before a connector marketplace. Governance when there
is more than one person to govern.

---

## Who it is for

**The analyst who lives in files.** Spreadsheets, exports, PDFs, and the
question that used to mean a week of pivot tables. They want DuckDB
through English, charts that are not screenshots of a hallucination, and
a report they can send.

**The operator of a private brain.** A founder, research lead, or
internal-tools owner who will put a Spark or a workstation on the LAN
and refuses to make the company’s memory a SaaS tenant.

**The small team sharing one private workspace.** Two to twenty people who
need shared evidence, named agents, scheduled work, and a reviewable log of
remote-capable activity — without standing up North’s cluster. Borealis already
provides the first same-instance slice through report snapshots, content-free
activity receipts, and reviewable automation output. The original M07 contract
is complete; broader team workflows and the separate advisor remediation remain
future work. Desktop-first does not mean single-player; it means the first ten
users should not require a platform team.

**Not the target, yet:** a hyperscaler IT org buying a Kubernetes
estate; a consumer who wants a general computer agent to file Slack
messages and triage GitHub; a company whose real requirement is
Microsoft 365 as the system of record. Those are adjacent. They are not
the wedge.

---

## What we will not become

- **A model company.** We will not win by shipping a better 27B. We win
  by making whoever’s 27B — or 70B on the Spark — useful over _your_
  data.
- **A Kubernetes North.** Private deployment matters. The first form of
  private is an app and a directory of files, not a Helm chart.
- **A Portable Computer clone.** We will not center general device
  control, consumer connectors, or cloud-advisor theatrics. We will
  steal only the discipline: local default, visible egress, receipts,
  contained models as a mode.
- **A chat wrapper.** If the durable objects disappear when the thread
  is deleted, we built a toy.
- **A silent exfiltration path.** “Local” that embeds every upload to a
  hosted API without saying so is a lie. Settings, badges, and docs
  tell the same story.
- **An unbounded agent.** No whole-home file walk. No user SQL that
  re-enables network. No renderer that navigates to user content.

---

## Horizons

This is direction, not a backlog. Several named slices already ship; their
completion record lives in the milestone ledger. The North and Portable
Computer archives remain dated research.

### Horizon 0 — honor what already works

Keep the current contract sharp: scoped sources, two-store retrieval,
bounded DuckDB, canonical charts, self-contained reports, loopback
desktop, visible and executable model compatibility, local OCR, and recoverable
workspace archives. A vision that cannot run the
personal-finance fixture end to end is fiction.

### Horizon 1 — the object on the desk

Keep making the Electron app feel like the product we just described.
Locality, model presence, and egress state now live in the chrome. The
composer treats library, model, and scope as one instrument. macOS has an
API-managed contained-model path, a Settings → Local engine management panel,
and ambient status beside “paste a cluster origin.” Curated engine/model setup
is still future work. The enduring bar is visual and operational: the whole
application should sit next to Portable
Computer without looking or behaving like an admin console.

### Horizon 2 — the intelligence layer

Reports now have versions and supersession lineage; charts have a durable
registry and originating-run links. Query receipts survive in chat. Libraries
sit above uploads. Named agents bind versioned instructions, Markdown skills,
and built-in tool selections without widening authorization, and numbered
citations connect claims to frozen evidence. Connector schedules and history make the
bounded public-URL catalog feel like part of a platform. The destination
continues beyond this first layer: more artifact kinds, governed agent tool and
source policy, regeneration from provenance, and citation-grade exports.

### Horizon 3 — the small-team platform

Same-instance report snapshots, content-free activity receipts, and interval
automations complete M07's first small-team slice, including shared-report
reads and connector-sync consent. Scheduled answers are reviewable chat output;
there is no separate approval inbox or multi-step workflow yet. The destination
is a fuller administration and audit plane for desktop-and-cluster deployment,
plus automations with explicit human
review for work that already has artifacts and evidence. Optional contained or
cluster-local sandboxes for code are deferred until they have a hard process
boundary with no network or filesystem and bounded CPU, time, and memory. Other
desktops wait for a sandbox and packaging story as strict as macOS.

We will know we are there when a partner can sit down at a MacBook,
point Borealis at a Spark, drop a data room, and feel — in the first
minute — that this is the private North they were told did not exist.

---

## Relationship to other documents

| Document                                          | Role                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [README](../README.md)                            | What the product does _now_, how to run it, and how to verify it                           |
| [API reference](API.md)                           | Current HTTP, SSE, and resource contracts                                                  |
| [Desktop guide](../desktop/README.md)             | Electron packaging, profiles, and native checks                                            |
| [Contributor instructions](../AGENTS.md)          | Architecture and security invariants for people who change the code                        |
| [Milestone ledger](../milestones/README.md)       | Active implementation ledger and completed slices toward this vision                       |
| [Functional product review](PRODUCT_REVIEW.md) | Dated competitive evidence and rationale for proposed functional milestones |
| [Advisor remediation](../advisor-plans/README.md) | Active engineering-remediation ledger from the 2026-08-30 audit, not product direction     |
| [North research archive](cohere-north/README.md)  | Dated external research (2026-08-22). Comparative evidence, not a Borealis spec or roadmap |
| [Completed plans](../plans/README.md)             | Historical implementation, not an active backlog                                           |

This file is the product we are aiming at. When vision and
implementation disagree, change the code on purpose or change this
page. Do not quietly treat the archives as a second product.
