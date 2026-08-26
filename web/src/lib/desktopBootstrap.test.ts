import { getToken, getUser, setSession } from "@/lib/api";
import { initializeDesktopSession, type BorealisDesktopBridge } from "@/lib/desktopBootstrap";

describe("desktop bootstrap", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete window.borealisDesktop;
  });

  it("stores a valid one-time preload session only for the current app launch", async () => {
    const bridge: BorealisDesktopBridge = {
      consumeBootstrap: vi.fn().mockResolvedValue({
        token: "desktop-jwt",
        user: { id: "desktop-user", email: "local@borealis.test" },
      }),
    };
    window.borealisDesktop = bridge;

    await Promise.all([initializeDesktopSession(), initializeDesktopSession()]);

    expect(bridge.consumeBootstrap).toHaveBeenCalledTimes(1);
    expect(getToken()).toBe("desktop-jwt");
    expect(getUser()).toEqual({ id: "desktop-user", email: "local@borealis.test" });
    expect(window.sessionStorage.getItem("borealis_token")).toBe("desktop-jwt");
    expect(window.localStorage.getItem("borealis_token")).toBeNull();
  });

  it("keeps the existing browser session when the preload has no bootstrap", async () => {
    setSession("browser-jwt", { id: "browser-user", email: "browser@example.test" });
    window.borealisDesktop = { consumeBootstrap: vi.fn().mockResolvedValue(null) };

    await initializeDesktopSession();

    expect(getToken()).toBe("browser-jwt");
    expect(getUser()).toEqual({ id: "browser-user", email: "browser@example.test" });
  });

  it("is a no-op when the desktop bridge is absent", async () => {
    setSession("browser-jwt", { id: "browser-user", email: "browser@example.test" });

    await expect(initializeDesktopSession()).resolves.toBeUndefined();

    expect(getToken()).toBe("browser-jwt");
    expect(getUser()).toEqual({ id: "browser-user", email: "browser@example.test" });
  });

  it("ignores rejected and malformed preload payloads without leaking them", async () => {
    const secret = "must-not-appear";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      window.borealisDesktop = {
        consumeBootstrap: vi.fn().mockResolvedValue({ token: secret, user: { id: "", email: "invalid" } }),
      } as BorealisDesktopBridge;

      await initializeDesktopSession();

      expect(getToken()).toBeNull();
      expect(document.body).not.toHaveTextContent(secret);

      window.borealisDesktop = { consumeBootstrap: vi.fn().mockRejectedValue(new Error(secret)) };
      await expect(initializeDesktopSession()).resolves.toBeUndefined();
      expect(getToken()).toBeNull();
      expect(document.body).not.toHaveTextContent(secret);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
