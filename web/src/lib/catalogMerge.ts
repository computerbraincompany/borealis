/** Merge a refreshed first page ahead of already loaded continuation rows. */
export function mergeCatalogHead<T extends { id: string }>(latest: readonly T[], current: readonly T[]): T[] {
  const latestIds = new Set(latest.map((item) => item.id));
  return [...latest, ...current.filter((item) => !latestIds.has(item.id))];
}

/**
 * Merge a continuation page without moving rows the user already sees.
 * Overlapping IDs take the server's fresh value; genuinely new rows append in
 * page order.
 */
export function mergeCatalogContinuation<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const currentIds = new Set(current.map((item) => item.id));
  return [
    ...current.map((item) => incomingById.get(item.id) ?? item),
    ...incoming.filter((item) => !currentIds.has(item.id)),
  ];
}
