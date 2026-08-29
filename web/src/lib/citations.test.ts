import { citeLinkify, parseCiteHref } from "@/lib/citations";

describe("citeLinkify", () => {
  it("rewrites a plain valid marker into a cite link", () => {
    expect(citeLinkify("Revenue grew [1] last year.", new Set([1]))).toBe("Revenue grew [1](cite://1) last year.");
  });

  it("leaves markers inside fenced code blocks untouched", () => {
    const markdown = [
      "See [1] now.",
      "",
      "```sql",
      "SELECT [1] FROM t",
      "```",
      "",
      "~~~",
      "[2] tilde block",
      "~~~",
    ].join("\n");
    const expected = [
      "See [1](cite://1) now.",
      "",
      "```sql",
      "SELECT [1] FROM t",
      "```",
      "",
      "~~~",
      "[2] tilde block",
      "~~~",
    ].join("\n");
    expect(citeLinkify(markdown, new Set([1, 2]))).toBe(expected);
  });

  it("leaves markers inside inline code untouched", () => {
    expect(citeLinkify("Use `[1]` literally, and cite [1] normally.", new Set([1]))).toBe(
      "Use `[1]` literally, and cite [1](cite://1) normally.",
    );
  });

  it("leaves markers inside double-backtick inline code untouched", () => {
    expect(citeLinkify("``[1]`` stays literal, [1] becomes a chip.", new Set([1]))).toBe(
      "``[1]`` stays literal, [1](cite://1) becomes a chip.",
    );
  });

  it("keeps invalid and unknown markers as literal text", () => {
    expect(citeLinkify("See [2], [abc], and [1] again.", new Set([1]))).toBe(
      "See [2], [abc], and [1](cite://1) again.",
    );
  });

  it("rewrites every occurrence of multiple markers", () => {
    expect(citeLinkify("[1] then [2] then [1]", new Set([1, 2]))).toBe(
      "[1](cite://1) then [2](cite://2) then [1](cite://1)",
    );
  });

  it("rewrites two-digit markers only when their number is valid", () => {
    expect(citeLinkify("Deep [12] marker [03] here", new Set([12]))).toBe("Deep [12](cite://12) marker [03] here");
  });

  it("leaves existing link syntax and reference definitions untouched", () => {
    const markdown = "[2](https://example.com) and [2][ref] and [2]: not-a-chip";
    expect(citeLinkify(markdown, new Set([2]))).toBe(markdown);
  });
});

describe("parseCiteHref", () => {
  it("parses valid cite hrefs and rejects everything else", () => {
    expect(parseCiteHref("cite://1")).toBe(1);
    expect(parseCiteHref("cite://12")).toBe(12);
    expect(parseCiteHref("cite://0")).toBeNull();
    expect(parseCiteHref("cite://123")).toBeNull();
    expect(parseCiteHref("cite://abc")).toBeNull();
    expect(parseCiteHref("cite://")).toBeNull();
    expect(parseCiteHref("https://example.com")).toBeNull();
  });
});
