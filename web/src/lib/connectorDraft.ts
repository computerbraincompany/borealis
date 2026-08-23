export interface ConnectorDraft {
  displayName: string;
  targetTable: string;
  type: "url_csv" | "url_json";
  url: string;
}

export type ConnectorDraftResult =
  | {
      ok: true;
      value: {
        display_name: string;
        target_table: string;
        type: "url_csv" | "url_json";
        config: { url: string };
      };
    }
  | { ok: false; error: string };

export function validateConnectorDraft(draft: ConnectorDraft): ConnectorDraftResult {
  const displayName = draft.displayName.trim();
  if (Array.from(displayName).length < 1 || Array.from(displayName).length > 120) {
    return { ok: false, error: "Display name must contain between 1 and 120 characters." };
  }

  const targetTable = draft.targetTable.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(targetTable)) {
    return {
      ok: false,
      error: "DuckDB table must start with a letter and contain only letters, digits, and underscores.",
    };
  }

  let url: URL;
  try {
    url = new URL(draft.url.trim());
  } catch {
    return { ok: false, error: "Dataset URL must be a valid HTTP(S) URL." };
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.toString().length > 2_000
  ) {
    return { ok: false, error: "Dataset URL must be an HTTP(S) URL without embedded credentials." };
  }
  url.hash = "";

  return {
    ok: true,
    value: {
      display_name: displayName,
      target_table: targetTable,
      type: draft.type,
      config: { url: url.toString() },
    },
  };
}
