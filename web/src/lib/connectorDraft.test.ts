import { validateConnectorDraft } from "@/lib/connectorDraft";

describe("validateConnectorDraft", () => {
  it("builds the explicit connector contract and normalizes its table and URL", () => {
    expect(
      validateConnectorDraft({
        displayName: "  Monthly ledger  ",
        targetTable: "Ledger_2026",
        type: "url_csv",
        url: "https://example.test/ledger.csv#fragment",
      }),
    ).toEqual({
      ok: true,
      value: {
        display_name: "Monthly ledger",
        target_table: "ledger_2026",
        type: "url_csv",
        config: { url: "https://example.test/ledger.csv" },
      },
    });
  });

  it.each([
    [{ displayName: "", targetTable: "ledger", url: "https://example.test/data.csv" }, /Display name/],
    [
      { displayName: "Ledger", targetTable: "2026_ledger", url: "https://example.test/data.csv" },
      /start with a letter/,
    ],
    [{ displayName: "Ledger", targetTable: "ledger-items", url: "https://example.test/data.csv" }, /underscores/],
    [{ displayName: "Ledger", targetTable: "ledger", url: "file:///tmp/data.csv" }, /HTTP\(S\)/],
    [{ displayName: "Ledger", targetTable: "ledger", url: "https://user:pass@example.test/data.csv" }, /credentials/],
  ])("rejects an invalid connector field", (partial, message) => {
    const result = validateConnectorDraft({
      displayName: partial.displayName,
      targetTable: partial.targetTable,
      type: "url_csv",
      url: partial.url,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});
