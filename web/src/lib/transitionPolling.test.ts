import { MAX_TRANSITION_STATUS_BATCH, selectPollingBatch } from "@/lib/transitionPolling";

const item = (id: string) => ({ id, transitioning: true });

describe("selectPollingBatch", () => {
  it("caps each batch and rotates through a stable catalog", () => {
    const items = Array.from({ length: 120 }, (_, index) => item(`old-${index + 1}`));
    const first = selectPollingBatch(items, (entry) => entry.transitioning, []);
    const second = selectPollingBatch(items, (entry) => entry.transitioning, first.nextQueue);
    const third = selectPollingBatch(items, (entry) => entry.transitioning, second.nextQueue);

    expect(first.ids).toHaveLength(MAX_TRANSITION_STATUS_BATCH);
    expect(second.ids).toHaveLength(MAX_TRANSITION_STATUS_BATCH);
    expect(new Set([...first.ids, ...second.ids, ...third.ids]).size).toBe(120);
  });

  it("does not starve the old tail when new rows are repeatedly prepended", () => {
    const old = Array.from({ length: 100 }, (_, index) => item(`old-${index + 1}`));
    const first = selectPollingBatch(old, (entry) => entry.transitioning, []);
    const withFirstWave = [...Array.from({ length: 50 }, (_, index) => item(`new-a-${index + 1}`)), ...old];
    const second = selectPollingBatch(withFirstWave, (entry) => entry.transitioning, first.nextQueue);
    const withSecondWave = [...Array.from({ length: 50 }, (_, index) => item(`new-b-${index + 1}`)), ...withFirstWave];
    const third = selectPollingBatch(withSecondWave, (entry) => entry.transitioning, second.nextQueue);

    expect(first.ids).toEqual(old.slice(0, 50).map((entry) => entry.id));
    expect(second.ids).toEqual(old.slice(50).map((entry) => entry.id));
    expect(third.ids.every((id) => id.startsWith("old-") || id.startsWith("new-a-"))).toBe(true);
  });
});
