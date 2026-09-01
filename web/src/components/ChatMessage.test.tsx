import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/ChartCard", () => ({
  ChartCard: ({ chartId }: { chartId: string }) => <div data-testid={`chart-${chartId}`}>Loaded chart</div>,
}));

import { ChatMessage } from "@/components/ChatMessage";
import type { CitationRef, RetrievedEvidence } from "@/lib/api";

const evidence: RetrievedEvidence[] = [
  { source_id: "source-1", chunk_id: "chunk-1", source: "Quarterly report", excerpt: "Revenue grew 4%.", score: 0.92 },
  { source_id: "source-2", chunk_id: "chunk-2", source: "Meeting notes", excerpt: "Costs held flat.", score: 0.71 },
];

const citations: CitationRef[] = [{ n: 1, source_id: "source-1", chunk_id: "chunk-1", source: "Quarterly report" }];

describe("ChatMessage citations", () => {
  it("renders a chip from meta citations that opens and highlights the passage", async () => {
    render(<ChatMessage role="assistant" content="Revenue grew [1]." evidence={evidence} citations={citations} />);

    const chip = screen.getByRole("button", { name: "Citation 1: Quarterly report" });
    expect(chip).toBeInTheDocument();
    await userEvent.click(chip);

    expect(document.querySelector("details")).toHaveAttribute("open");
    expect(screen.getByText("Revenue grew 4%.")).toHaveClass("ring-2", "ring-primary");
  });

  it("keeps unresolvable markers as literal text", () => {
    render(<ChatMessage role="assistant" content="See [2] and [1]." evidence={evidence} citations={citations} />);

    expect(screen.getByRole("button", { name: "Citation 1: Quarterly report" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Citation 2/ })).not.toBeInTheDocument();
    expect(screen.getByText(/See \[2\] and/)).toBeInTheDocument();
  });

  it("numbers evidence by index when meta citations are absent (history fallback)", () => {
    render(<ChatMessage role="assistant" content="Costs held [1] and revenue [2]." evidence={evidence} />);

    expect(screen.getByRole("button", { name: "Citation 1: Quarterly report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Citation 2: Meeting notes" })).toBeInTheDocument();
  });

  it("loads the chart renderer only for messages with chart metadata", async () => {
    const withoutChart = render(<ChatMessage role="assistant" content="No chart here." />);
    expect(screen.queryByText("Loaded chart")).not.toBeInTheDocument();
    withoutChart.unmount();

    render(<ChatMessage role="assistant" content="Chart follows." charts={["chart-1"]} />);
    expect(await screen.findByTestId("chart-chart-1")).toBeInTheDocument();
  });
});
