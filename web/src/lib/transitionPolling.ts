export const MAX_TRANSITION_STATUS_BATCH = 50;

export interface PollingBatch {
  ids: string[];
  nextQueue: string[];
}

/** Select a bounded round-robin batch so a large transitional catalog cannot fan out or starve older rows. */
export function selectPollingBatch<T extends { id: string }>(
  items: readonly T[],
  isTransitioning: (item: T) => boolean,
  previousQueue: readonly string[],
): PollingBatch {
  const eligibleIds = [...new Set(items.filter(isTransitioning).map((item) => item.id))];
  const eligible = new Set(eligibleIds);
  const queue: string[] = [];
  const queued = new Set<string>();
  for (const id of previousQueue) {
    if (eligible.has(id) && !queued.has(id)) {
      queue.push(id);
      queued.add(id);
    }
  }
  for (const id of eligibleIds) {
    if (!queued.has(id)) {
      queue.push(id);
      queued.add(id);
    }
  }
  const ids = queue.slice(0, MAX_TRANSITION_STATUS_BATCH);
  return { ids, nextQueue: [...queue.slice(ids.length), ...ids] };
}
