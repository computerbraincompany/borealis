/**
 * Document template contracts (M13 stage 2).
 *
 * A template snapshot is a structure-only document shape: title, subtitle,
 * and section headings with instruction/placeholder Markdown. The codec here
 * is the single enforcement point for the exclusion contract — charts (frozen
 * numeric values), tables (numeric results and analysis provenance), evidence
 * references (source excerpts, source identities, generations, content
 * identities, locators), and any credential- or binding-shaped material are
 * stripped by construction: `templateSnapshotFromTree` only ever copies the
 * `title`/`subtitle` and each section's `heading`/`markdown`, and
 * `normalizeTemplateSnapshot` rejects every other key with `exactKeys`.
 * Nothing that is not copied can be stored, so "save a document as a
 * template" can never carry private evidence, obsolete source bindings, or
 * numeric results into the catalog.
 *
 * Applying a template instantiates a blank draft tree with fresh document-
 * local section UUIDs and an explicitly unverified empty evidence envelope.
 * Templates never auto-bind sources, execute tools, or schedule work.
 */

import {
  DOCUMENT_SECTIONS_MAX,
  DOCUMENT_SECTION_HEADING_MAX_CHARS,
  DOCUMENT_SECTION_MARKDOWN_MAX_CHARS,
  DOCUMENT_SUBTITLE_MAX_CHARS,
  DOCUMENT_TITLE_MAX_CHARS,
  DocumentValidationError,
  type DocumentTree,
  type DocumentTreeInput,
} from "./documentTypes.js";

export const DOCUMENT_TEMPLATE_NAME_MAX_CHARS = 200;
export const DOCUMENT_TEMPLATE_DESCRIPTION_MAX_CHARS = 500;
export const DOCUMENT_TEMPLATES_MAX_PER_ACCOUNT = 100;

export interface DocumentTemplateSnapshot {
  readonly title: string;
  readonly subtitle: string;
  readonly sections: readonly { readonly heading: string; readonly markdown: string }[];
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

function invalid(message?: string): never {
  throw new DocumentValidationError("DOCUMENT_INVALID", message ?? "invalid template snapshot");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    invalid("template snapshot keys are restricted to structure-only fields");
  }
}

function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > maximum || (required && !value)) {
    invalid("template snapshot text violates the document bounds");
  }
  return value;
}

/**
 * Strict re-decode of a stored or received snapshot. The key sets below are
 * the exclusion proof: a snapshot containing `charts`, `tables`, `evidence`,
 * `analysis`, source identifiers, credentials, or bindings fails closed here
 * even if it reached the codec by any path.
 */
export function normalizeTemplateSnapshot(value: unknown): DocumentTemplateSnapshot {
  if (!isRecord(value)) invalid("template snapshot must be an object");
  exactKeys(value, ["title", "subtitle", "sections"]);
  const title = text(value.title, DOCUMENT_TITLE_MAX_CHARS, true);
  if (!title.trim()) invalid("template snapshot title must not be blank");
  const subtitle = text(value.subtitle ?? "", DOCUMENT_SUBTITLE_MAX_CHARS);
  if (!Array.isArray(value.sections) || value.sections.length > DOCUMENT_SECTIONS_MAX) {
    invalid("template snapshot sections are bounded");
  }
  const sections = Object.freeze(
    value.sections.map((section) => {
      if (!isRecord(section)) invalid("template snapshot section must be an object");
      exactKeys(section, ["heading", "markdown"]);
      return Object.freeze({
        heading: text(section.heading ?? "", DOCUMENT_SECTION_HEADING_MAX_CHARS),
        markdown: text(section.markdown ?? "", DOCUMENT_SECTION_MARKDOWN_MAX_CHARS),
      });
    })
  );
  return Object.freeze({ title, subtitle, sections });
}

/**
 * Captures the structure of one frozen revision tree as a template snapshot.
 * Charts, tables (including analysis provenance), and evidence are never
 * read; section Markdown is kept verbatim because instruction and prose
 * formatting is structure the user chose to reuse, while everything derived
 * from sources is excluded by the copy list above.
 */
export function templateSnapshotFromTree(tree: DocumentTree): DocumentTemplateSnapshot {
  return normalizeTemplateSnapshot({
    title: tree.title,
    subtitle: tree.subtitle,
    sections: tree.sections.map((section) => ({ heading: section.heading, markdown: section.markdown })),
  });
}

/**
 * Instantiates a draft tree input from a snapshot: fresh tree, no ids (the
 * document normalizer assigns stable section UUIDs), empty evidence, and an
 * explicitly unverified provenance flag because a template carries no
 * server-verified origin data.
 */
export function instantiateTemplateTree(snapshot: DocumentTemplateSnapshot, title?: string): DocumentTreeInput {
  return {
    title: (title ?? "").trim() || snapshot.title,
    subtitle: snapshot.subtitle,
    verified: false,
    sections: snapshot.sections.map((section) => ({ heading: section.heading, markdown: section.markdown })),
    charts: [],
    tables: [],
    evidence: [],
  };
}

// ---------------------------------------------------------------------------
// Built-in templates (server constants, never stored rows)
// ---------------------------------------------------------------------------

export interface BuiltinDocumentTemplate {
  readonly id: string;
  readonly built_in: true;
  readonly name: string;
  readonly description: string;
  readonly snapshot: DocumentTemplateSnapshot;
}

const MONTHLY_FINANCIAL_BRIEF: BuiltinDocumentTemplate = Object.freeze({
  id: "b0000000-0000-4000-8000-000000000001",
  built_in: true,
  name: "Monthly financial brief",
  description: "Recurring month-over-month money brief: summary, flows, categories, trends, data notes.",
  snapshot: normalizeTemplateSnapshot({
    title: "Monthly Financial Brief",
    subtitle: "Month in review",
    sections: [
      {
        heading: "Summary",
        markdown: "Three to five sentences on what changed this month and why it matters.",
      },
      {
        heading: "Income and Expenses",
        markdown:
          "Total income, total expenses, and net result for the month. Attach the saved analysis table here and note the period covered.",
      },
      {
        heading: "Category Breakdown",
        markdown:
          "Where the money went, largest categories first. Reference the attached table rather than restating every row.",
      },
      {
        heading: "Trends and Variance",
        markdown: "Month-over-month and year-over-year movement. Call out one-off items and known data gaps.",
      },
      {
        heading: "Data and Evidence",
        markdown:
          "List the sources and result versions behind every figure cited above. Mark anything unverified as unverified.",
      },
      {
        heading: "Decisions and Actions",
        markdown: "Concrete decisions or follow-ups implied by this month's numbers.",
      },
    ],
  }),
});

const EVIDENCE_MEMO: BuiltinDocumentTemplate = Object.freeze({
  id: "b0000000-0000-4000-8000-000000000002",
  built_in: true,
  name: "Evidence memo",
  description: "Claim under review with cited evidence, counter-evidence, caveats, and a conclusion.",
  snapshot: normalizeTemplateSnapshot({
    title: "Evidence Memo",
    subtitle: "",
    sections: [
      {
        heading: "Claim Under Review",
        markdown: "State the claim precisely, including its scope and the decision it supports.",
      },
      {
        heading: "Evidence Summary",
        markdown:
          "Walk through each piece of evidence in order. Cite it with its evidence number, e.g. [1], so the appendix resolves.",
      },
      {
        heading: "Counter-Evidence and Caveats",
        markdown:
          "Present contradicting or weakening evidence. Distinguish manual claims with no citation from cited claims.",
      },
      {
        heading: "Conclusion",
        markdown:
          "State the supported conclusion and its confidence. Where evidence is missing or unverified, say so explicitly.",
      },
    ],
  }),
});

const COMPARISON_REPORT: BuiltinDocumentTemplate = Object.freeze({
  id: "b0000000-0000-4000-8000-000000000003",
  built_in: true,
  name: "Comparison report",
  description: "Options compared against criteria with side-by-side results, trade-offs, and a recommendation.",
  snapshot: normalizeTemplateSnapshot({
    title: "Comparison Report",
    subtitle: "",
    sections: [
      {
        heading: "Options Compared",
        markdown: "Name every option considered, including those ruled out early, and why.",
      },
      {
        heading: "Criteria",
        markdown: "The decision criteria and their weights. Keep each criterion testable.",
      },
      {
        heading: "Side-by-Side Results",
        markdown:
          "Attach the comparison table here. Do not restate every cell in prose; interpret the meaningful deltas only.",
      },
      {
        heading: "Risks and Trade-offs",
        markdown: "Per-option risks, costs, and irreversible consequences.",
      },
      {
        heading: "Recommendation",
        markdown: "The recommended option, the criteria that drove it, and the evidence numbers behind the claims.",
      },
    ],
  }),
});

export const BUILTIN_DOCUMENT_TEMPLATES: readonly BuiltinDocumentTemplate[] = Object.freeze([
  MONTHLY_FINANCIAL_BRIEF,
  EVIDENCE_MEMO,
  COMPARISON_REPORT,
]);

const BUILTIN_BY_ID = new Map(BUILTIN_DOCUMENT_TEMPLATES.map((template) => [template.id, template]));

export function getBuiltinDocumentTemplate(id: string): BuiltinDocumentTemplate | undefined {
  return BUILTIN_BY_ID.get(id.toLowerCase());
}

export function serializeTemplateSnapshot(snapshot: DocumentTemplateSnapshot): string {
  return JSON.stringify({
    title: snapshot.title,
    subtitle: snapshot.subtitle,
    sections: snapshot.sections,
  });
}
