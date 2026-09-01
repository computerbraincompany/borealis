import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";

describe("catalog page merging", () => {
  it("puts a refreshed head first and replaces overlapping rows", () => {
    expect(
      mergeCatalogHead(
        [
          { id: "new", value: 2 },
          { id: "head", value: 2 },
        ],
        [
          { id: "head", value: 1 },
          { id: "older", value: 1 },
        ],
      ),
    ).toEqual([
      { id: "new", value: 2 },
      { id: "head", value: 2 },
      { id: "older", value: 1 },
    ]);
  });

  it("keeps stable row order while replacing continuation overlaps", () => {
    expect(
      mergeCatalogContinuation(
        [
          { id: "head", value: 1 },
          { id: "older", value: 1 },
        ],
        [
          { id: "inserted", value: 2 },
          { id: "older", value: 2 },
        ],
      ),
    ).toEqual([
      { id: "head", value: 1 },
      { id: "older", value: 2 },
      { id: "inserted", value: 2 },
    ]);
  });
});
