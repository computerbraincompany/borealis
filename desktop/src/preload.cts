import { contextBridge, ipcRenderer } from "electron";

interface BootstrapUser {
  readonly id: string;
  readonly email: string;
}

interface BootstrapSession {
  readonly token: string;
  readonly user: BootstrapUser;
}

contextBridge.exposeInMainWorld(
  "borealisDesktop",
  Object.freeze({
    consumeBootstrap: (): Promise<BootstrapSession | null> =>
      ipcRenderer.invoke("borealis:consume-bootstrap"),
  }),
);
