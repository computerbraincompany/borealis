import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ContainedConfig, ContainedDownloadState, ContainedEngineStatus, ContainedResponse } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  containedGet: vi.fn(),
  containedSaveConfig: vi.fn(),
  containedStartDownload: vi.fn(),
  containedCancelDownload: vi.fn(),
  containedStartEngine: vi.fn(),
  containedStopEngine: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    containedApi: {
      ...actual.containedApi,
      get: mocks.containedGet,
      saveConfig: mocks.containedSaveConfig,
      startDownload: mocks.containedStartDownload,
      cancelDownload: mocks.containedCancelDownload,
      startEngine: mocks.containedStartEngine,
      stopEngine: mocks.containedStopEngine,
    },
  };
});

import { ContainedPanel } from "@/components/ContainedPanel";

/** Redacted projection: basenames and a digest presence flag, never stored paths. */
const configOn: ContainedConfig = {
  enabled: true,
  binary: "llama-server",
  model: "tinyllama.gguf",
  binary_digest_configured: true,
  extra_arg_count: 0,
};

const configDisabled: ContainedConfig = {
  enabled: false,
  binary: null,
  model: null,
  binary_digest_configured: false,
  extra_arg_count: 0,
};

const engineOff: ContainedEngineStatus = {
  state: "off",
  model: null,
  endpoint_host: null,
  endpoint_managed_by_env: false,
  pid: null,
  started_at: null,
  error: null,
};

const engineHealthy: ContainedEngineStatus = {
  ...engineOff,
  state: "healthy",
  model: "tinyllama.gguf",
  endpoint_host: "127.0.0.1:54321",
  pid: 4242,
  started_at: "2026-09-01T10:00:00.000Z",
};

const downloadingRow: ContainedDownloadState = {
  filename: "tinyllama.gguf",
  url_host: "model.example.test",
  state: "downloading",
  bytes_received: 1536,
  total_bytes: 4096,
};

function containedResponse(overrides: Partial<ContainedResponse> = {}): ContainedResponse {
  return { config: configOn, engine: engineOff, downloads: [], ...overrides };
}

async function renderLoadedPanel(response: ContainedResponse) {
  mocks.containedGet.mockResolvedValue(response);
  render(<ContainedPanel />);
  await screen.findByLabelText("Binary path");
}

function summaryCard() {
  return screen.getByLabelText("Stored contained configuration");
}

describe("ContainedPanel", () => {
  beforeEach(() => {
    mocks.containedGet.mockReset();
    mocks.containedSaveConfig.mockReset();
    mocks.containedStartDownload.mockReset();
    mocks.containedCancelDownload.mockReset();
    mocks.containedStartEngine.mockReset();
    mocks.containedStopEngine.mockReset();
  });

  it("renders the stored config, engine state, and download rows from containedApi.get()", async () => {
    await renderLoadedPanel(containedResponse({ engine: engineHealthy, downloads: [downloadingRow] }));

    expect(screen.getByRole("checkbox", { name: /enable contained engine/i })).toBeChecked();
    // The projection never carries paths, so the write-side inputs start empty.
    expect(screen.getByLabelText("Binary path")).toHaveValue("");
    expect(screen.getByLabelText("Model path")).toHaveValue("");
    expect(screen.getByLabelText("Binary SHA-256")).toHaveValue("");
    const summary = summaryCard();
    expect(summary).toHaveTextContent("Enabled");
    expect(within(summary).getByText("llama-server")).toBeInTheDocument();
    expect(within(summary).getByText("tinyllama.gguf")).toBeInTheDocument();
    expect(summary).toHaveTextContent("binary digest configured");
    expect(summary).toHaveTextContent("no extra args");
    expect(screen.getByText("Running")).toBeInTheDocument();
    const engineCard = screen.getByLabelText("Contained engine state");
    expect(within(engineCard).getByText("tinyllama.gguf")).toBeInTheDocument();
    expect(within(engineCard).getByText("127.0.0.1:54321")).toBeInTheDocument();
    expect(screen.queryByText("endpoint managed by environment")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start engine" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop engine" })).toBeEnabled();

    const rows = screen.getByRole("list", { name: "Contained download progress" });
    expect(rows).toHaveTextContent("tinyllama.gguf");
    expect(rows).toHaveTextContent("model.example.test");
    expect(rows).toHaveTextContent("Downloading…");
    expect(rows).toHaveTextContent("1.5 KB of 4.0 KB");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("shows the extra-arg count from the projection", async () => {
    await renderLoadedPanel(containedResponse({ config: { ...configOn, extra_arg_count: 3 } }));
    expect(summaryCard()).toHaveTextContent("3 extra args");
  });

  it("summarizes a disabled projection without inventing names", async () => {
    await renderLoadedPanel(containedResponse({ config: configDisabled }));
    expect(summaryCard()).toHaveTextContent("A contained configuration is saved but disabled.");
    expect(screen.queryByText("Enabled")).not.toBeInTheDocument();
  });

  it("states that no configuration exists before the first save", async () => {
    await renderLoadedPanel(containedResponse({ config: null }));
    expect(summaryCard()).toHaveTextContent("No contained configuration has been saved yet.");
  });

  it("shows the endpoint-managed hint and crashed diagnostics while gating the engine buttons", async () => {
    await renderLoadedPanel(
      containedResponse({
        engine: {
          ...engineHealthy,
          state: "crashed",
          endpoint_host: null,
          endpoint_managed_by_env: true,
          pid: null,
          error: "the engine process exited unexpectedly",
        },
      }),
    );

    expect(screen.getByText("Crashed — see error below")).toBeInTheDocument();
    expect(screen.getByText("endpoint managed by environment")).toBeInTheDocument();
    expect(screen.getByText("the engine process exited unexpectedly")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start engine" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop engine" })).toBeDisabled();
  });

  it("saves an enabling draft with fresh paths and the binary digest through saveConfig", async () => {
    mocks.containedSaveConfig.mockResolvedValue({ ...configOn, extra_arg_count: 1 });
    await renderLoadedPanel(containedResponse({ config: configDisabled }));

    fireEvent.change(screen.getByLabelText("Binary path"), { target: { value: "/usr/local/bin/llama-server" } });
    fireEvent.change(screen.getByLabelText("Model path"), {
      target: { value: "/Users/operator/Models/tinyllama.gguf" },
    });
    fireEvent.change(screen.getByLabelText("Binary SHA-256"), { target: { value: "ab".repeat(32) } });
    fireEvent.click(screen.getByRole("checkbox", { name: /enable contained engine/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() =>
      expect(mocks.containedSaveConfig).toHaveBeenCalledWith(
        {
          enabled: true,
          binary_path: "/usr/local/bin/llama-server",
          model_path: "/Users/operator/Models/tinyllama.gguf",
          binary_sha256: "ab".repeat(32),
        },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("Contained configuration saved.")).toBeInTheDocument();
    expect(summaryCard()).toHaveTextContent("llama-server");
    expect(summaryCard()).toHaveTextContent("1 extra arg");
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeEnabled();
  });

  it("saves a plain disable without any path fields", async () => {
    mocks.containedSaveConfig.mockResolvedValue(configDisabled);
    await renderLoadedPanel(containedResponse());

    fireEvent.click(screen.getByRole("checkbox", { name: /enable contained engine/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() =>
      expect(mocks.containedSaveConfig).toHaveBeenCalledWith({ enabled: false }, expect.any(AbortSignal)),
    );
    expect(await screen.findByText("Contained configuration saved.")).toBeInTheDocument();
    expect(summaryCard()).toHaveTextContent("disabled");
  });

  it("blocks an invalid configuration before any request", async () => {
    await renderLoadedPanel(containedResponse({ config: configDisabled }));

    fireEvent.change(screen.getByLabelText("Binary path"), { target: { value: "models/llama-server" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Binary path must be an absolute path.");
    expect(mocks.containedSaveConfig).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Binary path"), { target: { value: "/usr/local/bin/llama-server" } });
    fireEvent.change(screen.getByLabelText("Model path"), {
      target: { value: "/Users/operator/Models/tinyllama.gguf" },
    });
    fireEvent.change(screen.getByLabelText("Binary SHA-256"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Binary SHA-256 must be a 64-character hex digest.");
    expect(mocks.containedSaveConfig).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Binary SHA-256"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /enable contained engine/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An enabled engine needs absolute binary and model paths and the binary's 64-character SHA-256.",
    );
    expect(mocks.containedSaveConfig).not.toHaveBeenCalled();
  });

  it("starts a download from the form and cancels the active download", async () => {
    mocks.containedStartDownload.mockResolvedValue(downloadingRow);
    mocks.containedCancelDownload.mockResolvedValue({ ok: true });
    await renderLoadedPanel(containedResponse({ downloads: [] }));

    fireEvent.change(screen.getByLabelText("Download URL"), {
      target: { value: "https://model.example.test/tinyllama.gguf" },
    });
    fireEvent.change(screen.getByLabelText("Model filename"), { target: { value: "tinyllama.gguf" } });
    fireEvent.change(screen.getByLabelText("SHA-256 checksum"), { target: { value: "ab".repeat(32) } });
    fireEvent.click(screen.getByRole("button", { name: "Start download" }));

    await waitFor(() =>
      expect(mocks.containedStartDownload).toHaveBeenCalledWith(
        {
          url: "https://model.example.test/tinyllama.gguf",
          filename: "tinyllama.gguf",
          sha256: "ab".repeat(32),
        },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("Download started for tinyllama.gguf.")).toBeInTheDocument();
    expect(screen.getByLabelText("Download URL")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(mocks.containedCancelDownload).toHaveBeenCalledWith("tinyllama.gguf", expect.any(AbortSignal)),
    );
    expect(await screen.findByText("Download cancelled for tinyllama.gguf.")).toBeInTheDocument();
  });

  it("validates the download form before any request", async () => {
    await renderLoadedPanel(containedResponse({ downloads: [] }));

    fireEvent.change(screen.getByLabelText("Download URL"), {
      target: { value: "https://model.example.test/tinyllama.gguf" },
    });
    fireEvent.change(screen.getByLabelText("Model filename"), { target: { value: "bad/name.gguf" } });
    fireEvent.change(screen.getByLabelText("SHA-256 checksum"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Start download" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Filename must be 1-180 characters of [A-Za-z0-9._-] without separators.",
    );
    expect(mocks.containedStartDownload).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Model filename"), { target: { value: "tinyllama.gguf" } });
    fireEvent.click(screen.getByRole("button", { name: "Start download" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("SHA-256 must be a 64-character hex digest.");
    expect(mocks.containedStartDownload).not.toHaveBeenCalled();
  });

  it("starts and stops the engine and reflects the returned states", async () => {
    mocks.containedStartEngine.mockResolvedValue({ ...engineOff, state: "starting", model: "tinyllama.gguf" });
    await renderLoadedPanel(containedResponse());

    fireEvent.click(screen.getByRole("button", { name: "Start engine" }));
    await waitFor(() => expect(mocks.containedStartEngine).toHaveBeenCalledWith(expect.any(AbortSignal)));
    expect(await screen.findByText("Starting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop engine" })).toBeEnabled();

    mocks.containedStopEngine.mockResolvedValue({ ...engineOff, state: "stopped" });
    fireEvent.click(screen.getByRole("button", { name: "Stop engine" }));
    await waitFor(() => expect(mocks.containedStopEngine).toHaveBeenCalledWith(expect.any(AbortSignal)));
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start engine" })).toBeEnabled();
  });

  it("surfaces a bounded load failure and retries through containedApi.get()", async () => {
    mocks.containedGet
      .mockRejectedValueOnce(new Error("secret socket path /private/var/borealis.sock"))
      .mockResolvedValueOnce(containedResponse());
    render(<ContainedPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Contained engine status is temporarily unavailable.");
    expect(screen.queryByText(/secret socket path/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Stored contained configuration")).toHaveTextContent("llama-server");
  });

  it("keeps operator edits when the two-second poll refreshes server state", async () => {
    vi.useFakeTimers();
    try {
      mocks.containedGet.mockResolvedValue(containedResponse());
      render(<ContainedPanel />);
      await act(async () => undefined);
      expect(summaryCard()).toHaveTextContent("llama-server");
      expect(screen.getByRole("checkbox", { name: /enable contained engine/i })).toBeChecked();

      fireEvent.change(screen.getByLabelText("Binary path"), { target: { value: "/next/bin/llama-server" } });
      mocks.containedGet.mockResolvedValue(containedResponse({ config: configDisabled }));
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });

      expect(mocks.containedGet).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText("Binary path")).toHaveValue("/next/bin/llama-server");
      expect(screen.getByRole("checkbox", { name: /enable contained engine/i })).toBeChecked();
    } finally {
      vi.useRealTimers();
    }
  });
});
