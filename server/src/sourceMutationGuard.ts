import { storageRuntime } from "./storageRuntime.js";

/**
 * Active runs carry normalized immutable source snapshots. New mutation code
 * should use a store transition that performs this guard in the same
 * `BEGIN IMMEDIATE` transaction as its write.
 */
export async function sourceReferencedByActiveRun(accountId: string, sourceId: string): Promise<boolean>;
/** @deprecated Compatibility for the old integration harness; the first value is ignored. */
export async function sourceReferencedByActiveRun(
  transactionOwner: unknown,
  accountId: string,
  sourceId: string
): Promise<boolean>;
export async function sourceReferencedByActiveRun(
  accountOrOwner: string | unknown,
  sourceOrAccount: string,
  optionalSource?: string
): Promise<boolean> {
  const accountId = optionalSource === undefined ? String(accountOrOwner) : sourceOrAccount;
  const sourceId = optionalSource ?? sourceOrAccount;
  return storageRuntime().chats.sourceReferencedByActiveRun(accountId, sourceId);
}
