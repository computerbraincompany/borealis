import path from "node:path";
import { config } from "./config.js";
import {
  createSettingsStore,
  type EffectiveLlmSettings,
  type SettingsSnapshot,
  type SettingsStore,
} from "./settingsStore.js";

export interface RuntimeSettingsSnapshot extends SettingsSnapshot {
  readonly revision: number;
}

export interface InitializeRuntimeSettingsOptions {
  readonly settingsFile?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface RuntimeSettingsState {
  readonly settingsFile: string;
  readonly store: SettingsStore;
  unsubscribe: () => void;
  current?: RuntimeSettingsSnapshot;
  loading?: Promise<RuntimeSettingsSnapshot>;
}

let state: RuntimeSettingsState | undefined;
let nextRevision = 0;

/** Initialize and load the process-wide settings source before accepting requests. */
export async function initializeRuntimeSettings(
  options: InitializeRuntimeSettingsOptions = {}
): Promise<RuntimeSettingsSnapshot> {
  return loadRuntimeSettings(getOrCreateState(options));
}

/** The singleton store to register with createSettingsRoutes. */
export function runtimeSettingsStore(): SettingsStore {
  return getOrCreateState().store;
}

/** Obtain one immutable effective snapshot for an operation. */
export async function getRuntimeSettings(): Promise<RuntimeSettingsSnapshot> {
  return loadRuntimeSettings(getOrCreateState());
}

export async function getEffectiveLlmSettings(): Promise<EffectiveLlmSettings> {
  return (await getRuntimeSettings()).settings;
}

/** Release the subscription so tests or an orderly shutdown can reinitialize. */
export function closeRuntimeSettings(): void {
  state?.unsubscribe();
  state = undefined;
}

function getOrCreateState(options: InitializeRuntimeSettingsOptions = {}): RuntimeSettingsState {
  if (state) {
    if (options.settingsFile !== undefined && state.settingsFile !== path.resolve(options.settingsFile)) {
      throw new Error("runtime settings are already initialized");
    }
    return state;
  }

  // Some focused route tests provide deliberately narrow config fakes. The
  // fallback is only a lazy identity; production config always supplies its
  // userData-backed settingsFile before any read or write.
  const settingsFile = path.resolve(
    options.settingsFile ?? config.settingsFile ?? path.join(process.cwd(), ".borealis", "settings.json")
  );
  const store = createSettingsStore({ path: settingsFile, env: options.env ?? process.env });
  const created: RuntimeSettingsState = {
    settingsFile,
    store,
    unsubscribe: () => {},
  };
  created.unsubscribe = store.subscribe((snapshot) => publishSnapshot(created, snapshot));
  state = created;
  return created;
}

function loadRuntimeSettings(target: RuntimeSettingsState): Promise<RuntimeSettingsSnapshot> {
  if (target.current) return Promise.resolve(target.current);
  if (target.loading) return target.loading;

  const loading = target.store.read().then((snapshot) => {
    if (!target.current) publishSnapshot(target, snapshot);
    return target.current as RuntimeSettingsSnapshot;
  });
  target.loading = loading;
  return loading.finally(() => {
    if (target.loading === loading) target.loading = undefined;
  });
}

function publishSnapshot(target: RuntimeSettingsState, snapshot: SettingsSnapshot): void {
  const revision =
    target.current && sameEffectiveSettings(target.current.settings, snapshot.settings)
      ? target.current.revision
      : ++nextRevision;
  target.current = Object.freeze({ ...snapshot, revision });
}

function sameEffectiveSettings(left: EffectiveLlmSettings, right: EffectiveLlmSettings): boolean {
  return (
    left.llmBaseUrl === right.llmBaseUrl &&
    left.apiKey === right.apiKey &&
    left.lmStudioBaseUrl === right.lmStudioBaseUrl &&
    left.chatModel === right.chatModel &&
    left.embedModel === right.embedModel &&
    left.embeddingDimension === right.embeddingDimension
  );
}
