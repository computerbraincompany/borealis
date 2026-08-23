import { render, screen } from "@testing-library/react";
import { ToolActivity, type ToolStep } from "@/components/ToolActivity";

describe("ToolActivity", () => {
  it("renders only safe summaries for legacy-shaped steps", () => {
    const legacy = {
      key: 1,
      name: "query_data",
      args: { sql: "SELECT secret FROM private_table" },
      summary: "Checking the selected table",
      status: "running",
    } as unknown as ToolStep;

    render(<ToolActivity steps={[legacy]} />);
    expect(screen.getByText("Checking the selected table")).toBeInTheDocument();
    expect(screen.queryByText(/SELECT secret/)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("private_table");
  });
});
