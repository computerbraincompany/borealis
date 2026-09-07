# Local research and comparison tables

Use Research to answer a question over an explicit set of indexed documents,
inspect the supporting passages, and retain a reviewed result independently of
chat. Research uses the configured model provider and the normal remote-egress
consent gate. It searches the selected corpus; it does not browse the web.

## Try the supplier example

The synthetic corpus in `data/e2e/supplier-corpus/` contains supplier agreements
and quotes with deliberately conflicting prices, missing facts, and one
unsupported file. Use an isolated test workspace for the example. Import the
folder through Libraries (a native folder connection on desktop, or a copied
directory in browser development), review the preview, and wait for supported
documents to become ready. An unsupported file is disclosed and excluded rather
than silently treated as readable evidence.

1. Open Research and create a definition. Ask which suppliers meet your criteria
   and which prices or terms require clarification. Select the ready supplier
   sources or expand their library into an explicit selection. Empty selection
   cannot start a run.
2. Generate a plan, inspect the questions, and edit or reorder them before saving.
   Generating a plan does not start research. Choose a comparison output and
   define fields such as price (`number`, with a currency unit), effective date
   (`date`), renewal (`boolean`), tier (`enum`, with explicit allowed values),
   and exceptions (`text`).
3. Start the saved definition. The run captures concrete source generations and
   its plan. You can navigate away or reload and return to the persisted run;
   progress and partial work do not depend on keeping the browser tab open.
4. Inspect the dossier and open cited passages in the passage panel. Check the
   document label, page/section/row location, excerpt, and any stale or unavailable
   location notice. A claim without valid supporting evidence must remain a gap.
5. Review the table. `not_found` with a null value means the fact was not found;
   `conflicting` means the evidence disagrees; `invalid` preserves output that
   failed the field's type contract or lacked valid evidence from that source.
   A numeric-looking string is not silently
   converted to a number. Correct a cell through review: the correction is
   labeled and stored separately from the immutable machine value.
6. Refresh a supplier document through its knowledge connection, then rerun the
   relevant row from Research. Inspect the changed-cell comparison and any
   carried corrections. Earlier run revisions retain their original excerpts,
   values, and review history. Refreshing the library does not silently alter an
   existing chat's selected sources.
7. Export CSV and the JSON evidence manifest from the stored run. CSV preserves
   machine values and corrections separately and guards spreadsheet formulas;
   the manifest carries exact run identity, captured generations, locators,
   evidence bindings, and correction provenance. Export does not rerun the model.
8. Create a reviewed document draft from a completed or `needs_review` run.
   Open it in the document workbench, resolve disclosed gaps and conflicts, and
   explicitly publish when ready. Published versions support HTML, PDF, Markdown
   ZIP, and DOCX downloads; older versions stay immutable.

## Interpret limits and recovery

Research is bounded. Budget exhaustion produces `needs_review` with explicit
gaps and retained partial evidence, rather than a complete-looking answer.
Table sorting/filtering is page-local and labeled as such. The stored comparison
table is limited to 1 MiB; the document projection is smaller (at most 60 rows,
32 columns, 1,000 preview cells, and 100 evidence references with bounded
excerpts). The draft discloses every omitted or shortened element; the CSV and
JSON manifest retain the complete stored result within its original bound.

Cancel requests are durable. Failed or cancelled runs remain inspectable but
cannot create a document artifact. After interruption, the runner follows its
bounded recovery policy; it does not claim unfinished work succeeded. Source
deletion preserves already captured excerpts while preventing a new run from
silently replacing that source. A stale edit asks you to reload the current
revision rather than overwriting a newer review.

The [API reference](API.md#local-research-shipped-in-the-m15-wave) records the
full limits, errors, lifecycle, and export contract. The
[execution ledger](../milestones/EXECUTION.md) records which browser, desktop,
and live-model scenarios have actually been verified.
