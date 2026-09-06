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
 * M14 narrow addition: the only other operation the renderer may reach.
 * It returns an opaque selection grant (id + label + bounded preview
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

contextBridge.exposeInMainWorld(
  "borealisDesktop",
  Object.freeze({
    consumeBootstrap: (): Promise<BootstrapSession | null> =>
      ipcRenderer.invoke("borealis:consume-bootstrap"),
    chooseFolder: (): Promise<FolderPickerResult> =>
      ipcRenderer.invoke("borealis:choose-folder"),
  }),
);
