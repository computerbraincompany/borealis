import type { AttachedSource, Source, SourceMode } from "@/lib/api";

export function toAttachedSource(source: Source): AttachedSource {
  return {
    id: source.id,
    name: source.name,
    display_name: source.display_name,
    kind: source.kind,
    status: source.status,
  };
}

/** Preserve selected-empty as an explicit deny-all scope; it must never widen to all. */
export function reconcileAttachedSources(
  mode: SourceMode,
  attached: AttachedSource[],
  available: Source[],
): AttachedSource[] {
  if (mode === "all") return available.map(toAttachedSource);

  const availableById = new Map(available.map((source) => [source.id, source]));
  return attached.flatMap((source) => {
    const current = availableById.get(source.id);
    return current ? [toAttachedSource(current)] : [];
  });
}

export function sameAttachedSources(left: AttachedSource[], right: AttachedSource[]): boolean {
  return (
    left.length === right.length &&
    left.every((source, index) => {
      const other = right[index];
      return (
        source.id === other.id &&
        source.name === other.name &&
        source.display_name === other.display_name &&
        source.kind === other.kind &&
        source.status === other.status
      );
    })
  );
}
