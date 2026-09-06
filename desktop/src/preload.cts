import { contextBridge, ipcRenderer } from "electron";

interface BootstrapUser {
  readonly id: string;
  readonly email: string;
}

interface BootstrapSession {
  readonly token: string;
  readonly user: BootstrapUser;
}

/**
 * M14 narrow addition: one of the two additional operations the renderer may
 * reach. It returns an opaque selection grant (id + label + bounded preview
 * metadata); the chosen directory's path never appears here — main forwards
 * that to the backend over the private utility-process channel. No path,
 * directory-listing, file-read, or general IPC surface is exposed.
 */
interface FolderPickerPreview {
  readonly entry_count: number;
  readonly truncated: boolean;
}

type FolderPickerResult =
  | { readonly cancelled: true }
  | {
      readonly cancelled: false;
      readonly grant_id: string;
      readonly label: string;
      readonly preview: FolderPickerPreview;
    };

interface OpenSignInLinkResult {
  readonly opened: boolean;
}

contextBridge.exposeInMainWorld(
  "borealisDesktop",
  Object.freeze({
    consumeBootstrap: (): Promise<BootstrapSession | null> =>
      ipcRenderer.invoke("borealis:consume-bootstrap"),
    chooseFolder: (): Promise<FolderPickerResult> =>
      ipcRenderer.invoke("borealis:choose-folder"),
    /**
     * The other stage-5 narrow addition: open the MCP connection sign-in
     * link in the SYSTEM browser, and only when the caller presents the
     * one-time intent token the backend minted for that exact URL (Connected
     * agents stage 5). Main verifies-and-consumes the token with the backend
     * before ever calling `shell.openExternal`; a renderer cannot open an
     * arbitrary URL through this channel.
     */
    openSignInLink: (
      token: unknown,
      url: unknown,
    ): Promise<OpenSignInLinkResult> =>
      ipcRenderer
        .invoke("borealis:open-external", {
          token: typeof token === "string" ? token : "",
          url: typeof url === "string" ? url : "",
        })
        .then((ok: unknown) => ({ opened: ok === true })),
  }),
);
