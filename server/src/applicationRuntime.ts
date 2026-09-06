import {
  createAutomationRunner,
  type AutomationRunner,
  type AutomationRunnerDependencies,
} from "./automationRunner.js";
import {
  bindDefaultAnalysisRunner,
  createAnalysisRunner,
  defaultAnalysisRunner,
  type AnalysisRunner,
  type AnalysisRunnerDependencies,
} from "./analysisRunner.js";
import {
  bindDefaultDocumentRewriteRunner,
  createDocumentRewriteRunner,
  defaultDocumentRewriteRunner,
  type DocumentRewriteRunner,
  type DocumentRewriteRunnerDependencies,
} from "./documentRewriteRunner.js";
import {
  bindDefaultResearchRunner,
  createResearchRunner,
  defaultResearchRunner,
  type ResearchRunner,
  type ResearchRunnerDependencies,
} from "./researchRunner.js";
import {
  bindDefaultBriefRunner,
  createBriefRunner,
  defaultBriefRunner,
  type BriefRunner,
  type BriefRunnerDependencies,
} from "./briefRunner.js";
import { config } from "./config.js";
import { syncConnector as syncConnectorRoute } from "./routes/connectors.js";
import {
  closeEmbeddingMigrationCoordinator,
  embeddingMigrationCoordinator,
  EmbeddingMigrationError,
} from "./embeddingMigration.js";
import {
  closeRuntimeSettings,
  getRuntimeSettings,
  initializeRuntimeSettings,
  type RuntimeSettingsSnapshot,
} from "./runtimeSettings.js";
import {
  closeStorageRuntime,
  initializeStorageRuntime,
  mayAdoptLegacyEmbeddingIdentity,
  type StorageRuntime,
  type StorageRuntimeOptions,
} from "./storageRuntime.js";
import { downloadManager, engineManager } from "./contained/runtime.js";
import { quiesceMcpConnections } from "./mcp/client.js";
import { closeOAuthCallbackListener } from "./mcp/oauthCallback.js";

/**
 * One owned application runtime per process.
 *
 * This module is the single composition owner for the process-lifetime
 * services a Borealis server needs: the paired SQLite/LanceDB storage
 * runtime, exactly one automation runner built over that storage's own
 * `automations` store, the managed embedding-migration coordinator
 * lifecycle, the contained download-manager lifecycle, the MCP connection
 * child drain, and the contained engine stop path. Settings and storage
 * closure are gated behind positive
 * drain proofs so a stale or partially built owner can never tear down a
 * newer runtime, and a runtime whose closure cannot be positively proven
 * poisons the process-wide ownership lease instead of risking an overlap
 * with a possibly live ledger, handle, or child.
 *
 * The module-private lease below is an ownership lock, not a service
 * locator: it is never exported, it stores no services, and every phase
 * transition compares exact token identity.
 */

export interface ApplicationRuntimeCloseProof {
  /**
   * Internal lifecycle proof, supplied only by server orchestration after
   * every external storage consumer (HTTP/chat runs, ingestion workers and
   * their OCR children, startup reconciliation, the dataset/DuckDB worker)
   * positively stopped. It is never an HTTP/request option.
   */
  readonly externalStorageConsumersDrained: boolean;
}

export interface ApplicationRuntime {
  /** The exact storage runtime this owner initialized. */
  readonly storage: StorageRuntime;
  /** The single automation runner over `storage.automations`. */
  readonly runner: AutomationRunner;
  /** The single saved-analysis executor over `storage.analyses`. */
  readonly analysisRunner: AnalysisRunner;
  /** The single document-rewrite executor over `storage.documents`. */
  readonly documentRewriteRunner: DocumentRewriteRunner;
  /** The single research executor over `storage.research` (M15 stage 2). */
  readonly researchRunner: ResearchRunner;
  /** The single reviewed-brief executor over `storage.briefRuns`. */
  readonly briefRunner: BriefRunner;
  startAutomationScheduler(): void;
  /** Synchronously quiesces the scheduler; the promise drains in-flight claims. */
  stopAutomationScheduler(): Promise<void>;
  /**
   * Startup resume for saved analyses: interrupted dispatched runs become
   * durable terminal records (never republished/rerun), then undispatched
   * queued runs are claimed, and the service surface becomes available.
   */
  startAnalysisRunner(): void;
  /** Synchronous quiescence plus statement interrupt; the promise drains every run row. */
  stopAnalysisRunner(): Promise<void>;
  /**
   * Startup resume for document rewrites: interrupted provider calls recover
   * as durable failed rows (never replayed), then undispatched queued
   * requests are claimed and the dispatch surface becomes available.
   */
  startDocumentRewriteRunner(): void;
  /** Synchronous quiescence plus transport interrupt; the promise drains every rewrite row. */
  stopDocumentRewriteRunner(): Promise<void>;
  /**
   * Startup resume for durable research (M15 stage 2): interrupted runs are
   * recovered (steps revert to `pending` for the bounded at-most-once retry),
   * then resumable rows are claimed one per account and the dispatch surface
   * becomes available.
   */
  startResearchRunner(): void;
  /**
   * Synchronous quiescence plus model-transport interrupt; the promise drains
   * every execution. Interrupted research stays durable `running` for the
   * bounded startup resume (never a silent rerun), cancelled rows settle
   * `cancelled`.
   */
  stopResearchRunner(): Promise<void>;
  /**
   * M16 stage 2: startup-resume recovered brief runs, claim due occurrences,
   * and dispatch on an unref'd interval (at most 1/account, 2 globally).
   * Interrupted runs stay in their committed stage for the same resume path.
   */
  startBriefRunner(): void;
  /** Synchronous quiescence plus bounded-wait interrupt; drains every execution. */
  stopBriefRunner(): Promise<void>;
  /** Synchronously closes contained-download admission; the promise drains it. */
  quiesceDownloads(): Promise<void>;
  /** Idempotent, proof-bearing close. The same promise is returned on repeat. */
  close(proof: ApplicationRuntimeCloseProof): Promise<void>;
}

/** The startup/rollback/finalization phases Plan 035 sequences around storage open. */
export interface EmbeddingMigrationPhase {
  recoverBeforeStorageOpen(): Promise<void>;
  finalizeAfterStorageOpen(): Promise<void>;
  rollbackStartupFailure(code: "STARTUP_OPEN_FAILED" | "STARTUP_SMOKE_FAILED"): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Injected lifecycle seam. Production defaults wire the real singletons;
 * tests inject explicit storage paths, sync adapter, download/migration
 * lifecycle, and settings/storage/engine functions. Never exposed over HTTP.
 */
export interface ApplicationRuntimeLifecycle {
  beginDownloadLifecycle(): Promise<void>;
  quiesceAndDrainDownloads(): Promise<void>;
  /**
   * Drains every still-live MCP connection session (owned stdio children
   * included) and resolves only after each release is proven. Optional so
   * existing lifecycle seams keep compiling; production defaults to the
   * `mcp/client` module drain.
   */
  quiesceAndDrainConnections?(): Promise<void>;
  initializeSettings(): Promise<unknown>;
  closeSettings(): void;
  readSettings(): Promise<RuntimeSettingsSnapshot>;
  makeMigration(): EmbeddingMigrationPhase;
  openStorage(options: StorageRuntimeOptions): Promise<StorageRuntime>;
  closeStorage(): Promise<void>;
  stopEngine(): Promise<unknown>;
  createRunner(dependencies: AutomationRunnerDependencies): AutomationRunner;
  createAnalysisRunner(dependencies: AnalysisRunnerDependencies): AnalysisRunner;
  /**
   * Optional so pre-M13 lifecycle seams keep compiling; production defaults
   * to the real document-rewrite executor.
   */
  createRewriteRunner?(dependencies: DocumentRewriteRunnerDependencies): DocumentRewriteRunner;
  /**
   * Optional so pre-M15 lifecycle seams keep compiling; production defaults
   * to the real research executor.
   */
  createResearchRunner?(dependencies: ResearchRunnerDependencies): ResearchRunner;
  /**
   * Optional so pre-M16 lifecycle seams keep compiling; production defaults
   * to the real reviewed-brief executor.
   */
  createBriefRunner?(dependencies: BriefRunnerDependencies): BriefRunner;
}

export interface ApplicationRuntimeOptions {
  readonly sqlitePath?: string;
  readonly lanceDirectory?: string;
  readonly syncConnector?: (accountId: string, connectorId: string) => Promise<unknown>;
  readonly lifecycle?: Partial<ApplicationRuntimeLifecycle>;
}

/** Stable, content-free lifecycle error. `leaseRetained` drives shutdown callers. */
export class ApplicationRuntimeLifecycleError extends Error {
  readonly code = "APPLICATION_RUNTIME_LIFECYCLE";
  readonly leaseRetained: boolean;
  readonly failedPhases: readonly string[];

  constructor(message: string, leaseRetained: boolean, failedPhases: readonly string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "ApplicationRuntimeLifecycleError";
    this.leaseRetained = leaseRetained;
    this.failedPhases = failedPhases;
  }
}

export function isApplicationRuntimeLeaseRetained(error: unknown): boolean {
  return error instanceof ApplicationRuntimeLifecycleError && error.leaseRetained;
}

type LeasePhase = "constructing" | "active" | "closing" | "closed" | "poisoned";

interface RuntimeLease {
  readonly token: object;
  phase: LeasePhase;
}

/**
 * The process-wide ownership lease. Exactly one token may hold any phase at a
 * time: an overlapping factory fails synchronously before any seam runs, and
 * a poisoned token is retained for the process lifetime so a possibly live
 * child, handle, or ledger is never overlapped by a "restart".
 */
let lease: RuntimeLease | undefined;

interface OwnedResources {
  downloadBegun: boolean;
  downloadReleased: boolean;
  connectionsReleased: boolean;
  settingsAcquired: boolean;
  settingsReleased: boolean;
  migration: EmbeddingMigrationPhase | undefined;
  migrationReleased: boolean;
  storage: StorageRuntime | undefined;
  storageReleased: boolean;
  runner: AutomationRunner | undefined;
  runnerReleased: boolean;
  analysisRunner: AnalysisRunner | undefined;
  analysisRunnerReleased: boolean;
  rewriteRunner: DocumentRewriteRunner | undefined;
  rewriteRunnerReleased: boolean;
  researchRunner: ResearchRunner | undefined;
  researchRunnerReleased: boolean;
  briefRunner: BriefRunner | undefined;
  briefRunnerReleased: boolean;
  engineReleased: boolean;
}

function newOwned(): OwnedResources {
  return {
    downloadBegun: false,
    downloadReleased: false,
    connectionsReleased: false,
    settingsAcquired: false,
    settingsReleased: false,
    migration: undefined,
    migrationReleased: false,
    storage: undefined,
    storageReleased: false,
    runner: undefined,
    runnerReleased: false,
    analysisRunner: undefined,
    analysisRunnerReleased: false,
    rewriteRunner: undefined,
    rewriteRunnerReleased: false,
    researchRunner: undefined,
    researchRunnerReleased: false,
    briefRunner: undefined,
    briefRunnerReleased: false,
    engineReleased: false,
  };
}

interface ResolvedLifecycle extends ApplicationRuntimeLifecycle {
  readonly syncConnector: (accountId: string, connectorId: string) => Promise<unknown>;
  readonly sqlitePath: string;
  readonly lanceDirectory: string;
  quiesceAndDrainConnections(): Promise<void>;
  createRewriteRunner(dependencies: DocumentRewriteRunnerDependencies): DocumentRewriteRunner;
  createResearchRunner(dependencies: ResearchRunnerDependencies): ResearchRunner;
  createBriefRunner(dependencies: BriefRunnerDependencies): BriefRunner;
}

function productionMigrationPhase(): EmbeddingMigrationPhase {
  const coordinator = embeddingMigrationCoordinator();
  return {
    recoverBeforeStorageOpen: () => coordinator.recoverBeforeStorageOpen(),
    finalizeAfterStorageOpen: () => coordinator.finalizeAfterStorageOpen(),
    rollbackStartupFailure: (code) => coordinator.rollbackStartupFailure(code),
    // Release through the module helper so a later runtime cannot inherit the
    // prior coordinator singleton.
    close: () => closeEmbeddingMigrationCoordinator(),
  };
}

function resolveLifecycle(options: ApplicationRuntimeOptions): ResolvedLifecycle {
  const lifecycle = options.lifecycle ?? {};
  return {
    beginDownloadLifecycle: lifecycle.beginDownloadLifecycle ?? (() => downloadManager.beginLifecycle()),
    quiesceAndDrainDownloads: lifecycle.quiesceAndDrainDownloads ?? (() => downloadManager.quiesceAndDrain()),
    quiesceAndDrainConnections:
      lifecycle.quiesceAndDrainConnections ??
      (async () => {
        await quiesceMcpConnections();
        // The backend-owned loopback OAuth callback listener is released as
        // part of the same connection drain during orderly shutdown.
        await closeOAuthCallbackListener();
      }),
    initializeSettings: lifecycle.initializeSettings ?? (() => initializeRuntimeSettings()),
    closeSettings: lifecycle.closeSettings ?? (() => closeRuntimeSettings()),
    readSettings: lifecycle.readSettings ?? (() => getRuntimeSettings()),
    makeMigration: lifecycle.makeMigration ?? (() => productionMigrationPhase()),
    openStorage: lifecycle.openStorage ?? ((init) => initializeStorageRuntime(init)),
    closeStorage: lifecycle.closeStorage ?? (() => closeStorageRuntime()),
    stopEngine:
      lifecycle.stopEngine ??
      (async () => {
        await engineManager.stop();
      }),
    createRunner: lifecycle.createRunner ?? ((deps) => createAutomationRunner(deps)),
    createAnalysisRunner: lifecycle.createAnalysisRunner ?? ((deps) => createAnalysisRunner(deps)),
    createRewriteRunner: lifecycle.createRewriteRunner ?? ((deps) => createDocumentRewriteRunner(deps)),
    createResearchRunner: lifecycle.createResearchRunner ?? ((deps) => createResearchRunner(deps)),
    createBriefRunner: lifecycle.createBriefRunner ?? ((deps) => createBriefRunner(deps)),
    syncConnector:
      options.syncConnector ?? ((accountId, connectorId) => syncConnectorRoute(accountId, undefined, connectorId)),
    sqlitePath: options.sqlitePath ?? config.sqlitePath,
    lanceDirectory: options.lanceDirectory ?? config.lanceDir,
  };
}

async function openConfiguredStorage(lifecycle: ResolvedLifecycle): Promise<StorageRuntime> {
  const snapshot = await lifecycle.readSettings();
  return lifecycle.openStorage({
    sqlitePath: lifecycle.sqlitePath,
    lanceDirectory: lifecycle.lanceDirectory,
    embeddingDimension: snapshot.settings.embeddingDimension,
    embeddingModel: snapshot.settings.embedModel,
    allowLegacyEmbeddingIdentityAdoption: mayAdoptLegacyEmbeddingIdentity(snapshot),
  });
}

/**
 * Plan 035's exact startup sequence, moved from the old `db.ts` `initDb`:
 * recover any journaled swap before the store opens, open SQLite/Lance from
 * the effective resolved embedding identity, then finalize or roll back
 * through the existing fail-closed paths.
 */
async function openStorageThroughMigration(
  lifecycle: ResolvedLifecycle,
  migration: EmbeddingMigrationPhase,
  owned: OwnedResources
): Promise<StorageRuntime> {
  await migration.recoverBeforeStorageOpen();
  try {
    owned.storage = await openConfiguredStorage(lifecycle);
  } catch (error) {
    if (!(await migration.rollbackStartupFailure("STARTUP_OPEN_FAILED"))) throw error;
    owned.storage = await openConfiguredStorage(lifecycle);
    return owned.storage;
  }
  try {
    await migration.finalizeAfterStorageOpen();
  } catch (error) {
    if (!(error instanceof EmbeddingMigrationError) || error.code !== "STARTUP_SMOKE_FAILED") {
      await lifecycle.closeStorage().catch(() => undefined);
      throw error;
    }
    await lifecycle.closeStorage();
    owned.storage = undefined;
    if (!(await migration.rollbackStartupFailure("STARTUP_SMOKE_FAILED"))) throw error;
    owned.storage = await openConfiguredStorage(lifecycle);
  }
  return owned.storage;
}

function settledCloseSettings(lifecycle: ResolvedLifecycle): boolean {
  try {
    lifecycle.closeSettings();
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt-all unwind for exactly what this token acquired during
 * construction. Returns `true` when every acquired resource positively
 * reported drained/closed (clean unwind), `false` when ownership of any
 * exact resource remains uncertain (the caller must poison).
 */
async function unwindConstruction(
  lifecycle: ResolvedLifecycle,
  owned: OwnedResources,
  uncertainAcquisition: boolean
): Promise<boolean> {
  // Independent owned drains first: the begun download lifecycle, the
  // migration coordinator, and the MCP connection registry (empty unless a
  // construction-time seam itself opened a connection). No scheduler ever
  // started and no HTTP surface was built, so settings/storage consumers are
  // limited to these phases.
  const [downloadResult, migrationResult, connectionsResult, rewriteResult, researchResult, briefResult] =
    await Promise.allSettled([
    owned.downloadBegun && !owned.downloadReleased ? lifecycle.quiesceAndDrainDownloads() : Promise.resolve(),
    owned.migration && !owned.migrationReleased ? owned.migration.close() : Promise.resolve(),
    lifecycle.quiesceAndDrainConnections(),
    owned.rewriteRunner && !owned.rewriteRunnerReleased ? owned.rewriteRunner.stop() : Promise.resolve(),
    owned.researchRunner && !owned.researchRunnerReleased ? owned.researchRunner.stop() : Promise.resolve(),
    owned.briefRunner && !owned.briefRunnerReleased ? owned.briefRunner.stop() : Promise.resolve(),
  ]);
  if (owned.briefRunner && briefResult.status === "fulfilled") owned.briefRunnerReleased = true;
  if (owned.rewriteRunner && rewriteResult.status === "fulfilled") owned.rewriteRunnerReleased = true;
  if (owned.researchRunner && researchResult.status === "fulfilled") owned.researchRunnerReleased = true;
  if (owned.downloadBegun && downloadResult.status === "fulfilled") owned.downloadReleased = true;
  if (owned.migration && migrationResult.status === "fulfilled") owned.migrationReleased = true;
  if (connectionsResult.status === "fulfilled") owned.connectionsReleased = true;

  // Storage close: attempted best-effort when the acquisition boundary was
  // uncertain (the initializer can reject after native open work); attempted
  // only after the independent drains when storage was positively opened.
  if (!owned.storageReleased && (owned.storage !== undefined || uncertainAcquisition)) {
    const storageResult = await Promise.resolve(lifecycle.closeStorage()).then(
      () => "fulfilled" as const,
      () => "rejected" as const
    );
    if (storageResult === "fulfilled") owned.storageReleased = true;
  }
  // Settings close is safe once the drains above are attempted and no engine
  // or scheduler was ever acquired by this token.
  if (owned.settingsAcquired && !owned.settingsReleased && settledCloseSettings(lifecycle)) {
    owned.settingsReleased = true;
  }

  const uncertain =
    uncertainAcquisition ||
    (owned.downloadBegun && !owned.downloadReleased) ||
    (owned.migration !== undefined && !owned.migrationReleased) ||
    (owned.storage !== undefined && !owned.storageReleased) ||
    (owned.settingsAcquired && !owned.settingsReleased) ||
    connectionsResult.status === "rejected";
  return !uncertain;
}

/**
 * Create the single owned application runtime for this process.
 *
 * A module-private exact-owner lease is reserved synchronously before the
 * factory's first await; an overlapping factory rejects before invoking any
 * initialize/begin/close/cleanup seam. Sequential restart is supported: a new
 * lifecycle begins only after the prior owner has fully drained and released.
 */
export async function createApplicationRuntime(options: ApplicationRuntimeOptions = {}): Promise<ApplicationRuntime> {
  // Synchronous lease reservation before the first await: any token owning
  // any phase (including `poisoned`) blocks construction with a stable error
  // and zero side effects.
  if (lease !== undefined) {
    throw new ApplicationRuntimeLifecycleError("an application runtime already owns this process", false, [
      "ownership-lease",
    ]);
  }
  const token: object = {};
  const current: RuntimeLease = { token, phase: "constructing" };
  lease = current;

  const lifecycle = resolveLifecycle(options);
  const owned = newOwned();
  // `initializeRuntimeSettings`/`initializeStorageRuntime` invocations are
  // acquisition boundaries: a rejection has no typed no-acquisition/full-
  // unwind proof, so ownership becomes uncertain and poisons.
  let uncertainAcquisition = false;

  try {
    // Plan 008: reopen the download lifecycle before any resource construction.
    await lifecycle.beginDownloadLifecycle();
    owned.downloadBegun = true;

    try {
      await lifecycle.initializeSettings();
    } catch (error) {
      // The invocation is an acquisition boundary: treat the settings state
      // as (uncertainly) acquired so the unwind still attempts its only safe
      // release — the synchronous subscription close.
      owned.settingsAcquired = true;
      uncertainAcquisition = true;
      throw error;
    }
    owned.settingsAcquired = true;

    owned.migration = lifecycle.makeMigration();
    try {
      owned.storage = await openStorageThroughMigration(lifecycle, owned.migration, owned);
    } catch (error) {
      // The wrapped storage initializer can reject after native open work and
      // hide cleanup failures; never infer that nothing opened.
      uncertainAcquisition = true;
      throw error;
    }

    owned.runner = lifecycle.createRunner({
      store: owned.storage.automations,
      syncConnector: (accountId, connectorId) => lifecycle.syncConnector(accountId, connectorId),
    });
    owned.analysisRunner = lifecycle.createAnalysisRunner({
      store: owned.storage.analyses,
      sources: owned.storage.sources,
    });
    owned.rewriteRunner = lifecycle.createRewriteRunner({
      store: owned.storage.documents,
      chats: owned.storage.chats,
    });
    owned.researchRunner = lifecycle.createResearchRunner({ store: owned.storage.research });
    // M16 stage 2: the reviewed-brief executor over the same storage. Its
    // service ports default to the production singletons inside
    // `createBriefRunner`, except the injected connector sync seam, which
    // reuses the lifecycle's exact adapter so tests never touch real URLs.
    owned.briefRunner = lifecycle.createBriefRunner({
      runs: owned.storage.briefRuns,
      recipes: owned.storage.briefRecipes,
      sources: owned.storage.sources,
      analyses: owned.storage.analyses,
      knowledge: owned.storage.knowledge,
      syncConnector: (accountId, connectorId) => lifecycle.syncConnector(accountId, connectorId),
    });
  } catch (error) {
    const cleanUnwind = await unwindConstruction(lifecycle, owned, uncertainAcquisition);
    if (cleanUnwind) {
      // Every acquired resource positively closed: release this exact lease.
      if (lease?.token === token) lease = undefined;
      current.phase = "closed";
      throw error;
    }
    // Uncertain closure: retain and poison the exact lease for the process
    // lifetime; every later factory fails before side effects.
    if (lease?.token === token) lease.phase = "poisoned";
    current.phase = "poisoned";
    throw new ApplicationRuntimeLifecycleError(
      "application runtime construction could not prove closure",
      true,
      ["construction"],
      { cause: error }
    );
  }

  current.phase = "active";
  const storage = owned.storage as StorageRuntime;
  const runner = owned.runner as AutomationRunner;
  const analysisRunner = owned.analysisRunner as AnalysisRunner;
  const rewriteRunner = owned.rewriteRunner as DocumentRewriteRunner;
  const researchRunner = owned.researchRunner as ResearchRunner;
  const briefRunner = owned.briefRunner as BriefRunner;

  let closePromise: Promise<void> | undefined;
  const runtime: ApplicationRuntime = Object.freeze({
    storage,
    runner,
    analysisRunner,
    documentRewriteRunner: rewriteRunner,
    researchRunner,
    briefRunner,
    startAutomationScheduler(): void {
      if (current.phase !== "active") {
        throw new ApplicationRuntimeLifecycleError("application runtime is not active", true, ["phase"]);
      }
      runner.start();
    },
    stopAutomationScheduler(): Promise<void> {
      // Plan 013 contract: synchronous quiescence; the promise settles only
      // after the active tick settles.
      return runner.stop();
    },
    startAnalysisRunner(): void {
      if (current.phase !== "active") {
        throw new ApplicationRuntimeLifecycleError("application runtime is not active", true, ["phase"]);
      }
      bindDefaultAnalysisRunner(analysisRunner);
      analysisRunner.start();
    },
    stopAnalysisRunner(): Promise<void> {
      // Synchronous quiescence plus statement interrupt; the promise settles
      // only after every execution has finalized its durable run row.
      return analysisRunner.stop();
    },
    startDocumentRewriteRunner(): void {
      if (current.phase !== "active") {
        throw new ApplicationRuntimeLifecycleError("application runtime is not active", true, ["phase"]);
      }
      bindDefaultDocumentRewriteRunner(rewriteRunner);
      rewriteRunner.start();
    },
    stopDocumentRewriteRunner(): Promise<void> {
      // Synchronous quiescence plus provider-transport interrupt; the promise
      // settles only after every rewrite finalized its durable row (failed,
      // never replayed; cancelled when a cancellation was requested).
      return rewriteRunner.stop();
    },
    startResearchRunner(): void {
      if (current.phase !== "active") {
        throw new ApplicationRuntimeLifecycleError("application runtime is not active", true, ["phase"]);
      }
      bindDefaultResearchRunner(researchRunner);
      researchRunner.start();
    },
    stopResearchRunner(): Promise<void> {
      // Synchronous quiescence plus model-transport interrupt; the promise
      // settles only after every research execution stopped. Interrupted runs
      // stay durable `running` for the bounded startup resume, never orphaned
      // as a silent rerun; cancelled rows finalize `cancelled`.
      return researchRunner.stop();
    },
    startBriefRunner(): void {
      if (current.phase !== "active") {
        throw new ApplicationRuntimeLifecycleError("application runtime is not active", true, ["phase"]);
      }
      bindDefaultBriefRunner(briefRunner);
      // M16 stage 2: restart resumes every non-terminal run from its committed
      // receipts (never a second artifact), then claims due occurrences.
      briefRunner.start();
    },
    stopBriefRunner(): Promise<void> {
      // Synchronous quiescence plus bounded-wait interrupt; the promise
      // settles only after every execution either finalized its durable row
      // (cancelled when a cancellation was requested) or left it in its
      // committed stage for the next startup resume.
      return briefRunner.stop();
    },
    quiesceDownloads(): Promise<void> {
      // Plan 008 contract: synchronous admission closure; the promise joins
      // every captured reservation.
      return lifecycle.quiesceAndDrainDownloads();
    },
    close(proof: ApplicationRuntimeCloseProof): Promise<void> {
      closePromise ??= runClose(proof);
      return closePromise;
    },
  });

  function poison(failedPhases: readonly string[]): never {
    if (lease?.token === token) lease.phase = "poisoned";
    throw new ApplicationRuntimeLifecycleError("application runtime close could not prove closure", true, failedPhases);
  }

  function runClose(proof: ApplicationRuntimeCloseProof): Promise<void> {
    // Synchronous phase entry before the first await.
    if (current.phase === "closed") return Promise.resolve();
    if (current.phase === "poisoned") {
      return Promise.reject(
        new ApplicationRuntimeLifecycleError("application runtime close is poisoned", true, ["phase"])
      );
    }
    current.phase = "closing";

    return (async () => {
      // Owned cleanup dependency graph: scheduler, analysis runner, download,
      // migration, engine, and MCP connections are independent phases with
      // attempt-all/all-settled semantics. Calling the already-started
      // scheduler/download/connections drains again simply joins their
      // retained promises.
      const [
        runnerResult,
        analysisRunnerResult,
        rewriteRunnerResult,
        researchRunnerResult,
        briefRunnerResult,
        downloadResult,
        migrationResult,
        engineResult,
        connectionsResult,
      ] = await Promise.allSettled([
        runner.stop(),
        analysisRunner.stop(),
        rewriteRunner.stop(),
        researchRunner.stop(),
        briefRunner.stop(),
        lifecycle.quiesceAndDrainDownloads(),
        owned.migration?.close() ?? Promise.resolve(),
        lifecycle.stopEngine(),
        lifecycle.quiesceAndDrainConnections(),
      ]);
      const failed: string[] = [];
      if (runnerResult.status === "fulfilled") owned.runnerReleased = true;
      else failed.push("scheduler");
      if (analysisRunnerResult.status === "fulfilled") {
        owned.analysisRunnerReleased = true;
        // The executor drained its final durable rows; the service surface is
        // unavailable again and any queued run survives for the next resume.
        if (defaultAnalysisRunner() === analysisRunner) bindDefaultAnalysisRunner(undefined);
      } else failed.push("analysis-runner");
      if (rewriteRunnerResult.status === "fulfilled") {
        owned.rewriteRunnerReleased = true;
        // The rewrite executor drained its final durable rows; interrupted
        // transports are durable failures and queued rows survive for the
        // next resume.
        if (defaultDocumentRewriteRunner() === rewriteRunner) bindDefaultDocumentRewriteRunner(undefined);
      } else failed.push("rewrite-runner");
      if (researchRunnerResult.status === "fulfilled") {
        owned.researchRunnerReleased = true;
        // The research executor drained its final executions; an interrupted
        // run stays durable `running` for the bounded startup resume, a
        // cancelled run settled `cancelled`, and queued rows survive.
        if (defaultResearchRunner() === researchRunner) bindDefaultResearchRunner(undefined);
      } else failed.push("research-runner");
      if (briefRunnerResult.status === "fulfilled") {
        owned.briefRunnerReleased = true;
        // The executor drained every execution; interrupted runs remain in
        // their committed stage for the next startup resume and the manual
        // wake surface becomes unavailable again.
        if (defaultBriefRunner() === briefRunner) bindDefaultBriefRunner(undefined);
      } else failed.push("brief-runner");
      if (downloadResult.status === "fulfilled") owned.downloadReleased = true;
      else failed.push("download");
      if (migrationResult.status === "fulfilled") owned.migrationReleased = true;
      else failed.push("migration");
      if (engineResult.status === "fulfilled") owned.engineReleased = true;
      else failed.push("engine");
      if (connectionsResult.status === "fulfilled") owned.connectionsReleased = true;
      else failed.push("connections");

      const externalDrained = proof?.externalStorageConsumersDrained === true;
      if (failed.length > 0 || !externalDrained) {
        // Settings and storage stay owned and open — deliberately skipped
        // because a consumer or the external proof is not positively drained.
        if (!externalDrained) failed.push("external-consumers");
        failed.push("settings(skipped)", "storage(skipped)");
        poison(failed);
      }

      // Settings and storage may close only now: every owned drain settled
      // and the external storage consumers are positively proven drained.
      let storageFailure = false;
      try {
        await lifecycle.closeStorage();
        owned.storageReleased = true;
        owned.storage = undefined;
      } catch {
        storageFailure = true;
      }
      // A failed storage close does not prevent an otherwise-safe settings
      // close now that every consumer and the engine are proven stopped — but
      // either failure prevents lease release.
      const settingsClosed = settledCloseSettings(lifecycle);
      if (settingsClosed) owned.settingsReleased = true;
      if (storageFailure) failed.push("storage");
      if (!settingsClosed) failed.push("settings");
      if (failed.length > 0) poison(failed);

      if (lease?.token === token) lease = undefined;
      current.phase = "closed";
    })();
  }

  return runtime;
}
