import { SOURCE_FILE_ACCEPT } from "@/lib/sourceFiles";

describe("source file picker contract", () => {
  it("offers DOCX but not unsupported legacy DOC uploads", () => {
    const extensions = SOURCE_FILE_ACCEPT.split(",");
    expect(extensions).toContain(".docx");
    expect(extensions).toContain(".json");
    expect(extensions).not.toContain(".doc");
    expect(extensions).not.toContain(".xls");
  });
});
