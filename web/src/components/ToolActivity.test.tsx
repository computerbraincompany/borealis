import { render, screen } from "@testing-library/react";
import { ToolActivity, type ToolStep } from "@/components/ToolActivity";

describe("ToolActivity", () => {
  it("keeps repeated operations collapsed and counts failures separately", () => {
    render(
      <ToolActivity
        running={true}
        steps={[
          { key: 1, name: "query_data", status: "done", summary: "Running query", resultSummary: "Query finished" },
          { key: 2, name: "query_data", status: "error", summary: "Running query", resultSummary: "Query rejected" },
        ]}
      />,
    );
    expect(screen.getByText("Borealis is working")).toBeInTheDocument();
    expect(screen.getByText(/1 completed · 1 failed/)).toBeInTheDocument();
    expect(document.querySelector("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("Running query")).not.toBeInTheDocument();
  });

  it("renders only safe summaries for legacy-shaped steps", () => {
    const legacy = {
      key: 1,
      name: "query_data",
      args: { sql: "SELECT secret FROM private_table" },
      summary: "Checking the selected table",
      status: "running",
    } as unknown as ToolStep;

    render(<ToolActivity steps={[legacy]} />);
    expect(screen.getAllByText("Checking the selected table")[0]).toBeInTheDocument();
    expect(screen.queryByText(/SELECT secret/)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("private_table");
  });
});
