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

const configOn: ContainedConfig = {
  enabled: true,
  binary_path: "/opt/homebrew/bin/llama-server",
  model_path: "/Users/operator/Models/tinyllama.gguf",
  extra_args: [],
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
    expect(screen.getByLabelText("Binary path")).toHaveValue("/opt/homebrew/bin/llama-server");
    expect(screen.getByLabelText("Model path")).toHaveValue("/Users/operator/Models/tinyllama.gguf");
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

  it("saves the edited configuration draft through saveConfig", async () => {
    mocks.containedSaveConfig.mockResolvedValue({
      ...configOn,
      enabled: false,
      binary_path: "/usr/local/bin/llama-server",
    });
    await renderLoadedPanel(containedResponse());

    fireEvent.change(screen.getByLabelText("Binary path"), { target: { value: "/usr/local/bin/llama-server" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /enable contained engine/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() =>
      expect(mocks.containedSaveConfig).toHaveBeenCalledWith(
        { enabled: false, binary_path: "/usr/local/bin/llama-server", model_path: configOn.model_path },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("Contained configuration saved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeEnabled();
  });

  it("blocks an invalid configuration before any request", async () => {
    await renderLoadedPanel(containedResponse({ config: { ...configOn, enabled: false } }));

    fireEvent.change(screen.getByLabelText("Binary path"), { target: { value: "models/llama-server" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Binary path must be an absolute path.");
    expect(mocks.containedSaveConfig).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Binary path"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /enable contained engine/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An enabled engine needs absolute binary and model paths.",
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
    expect(await screen.findByLabelText("Binary path")).toHaveValue(configOn.binary_path);
  });

  it("keeps operator edits when the two-second poll refreshes server state", async () => {
    vi.useFakeTimers();
    try {
      mocks.containedGet.mockResolvedValue(containedResponse());
      render(<ContainedPanel />);
      await act(async () => undefined);
      expect(screen.getByLabelText("Binary path")).toHaveValue(configOn.binary_path);

      fireEvent.change(screen.getByLabelText("Binary path"), { target: { value: "/next/bin/llama-server" } });
      mocks.containedGet.mockResolvedValue(containedResponse({ config: { ...configOn, enabled: false } }));
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
