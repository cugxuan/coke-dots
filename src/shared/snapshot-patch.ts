import type { Snapshot } from './types.ts';

type Identified = { id: string | number };
type ListPatch<T extends Identified> = { upsert: T[]; order?: T['id'][] };
type Values = Omit<Snapshot, 'tasks' | 'entries' | 'watches'>;

export interface SnapshotPatch {
  values?: Partial<Values>;
  tasks?: ListPatch<Snapshot['tasks'][number]>;
  entries?: ListPatch<Snapshot['entries'][number]>;
  watches?: ListPatch<Snapshot['watches'][number]>;
}

function diffList<T extends Identified>(previous: T[], next: T[]): ListPatch<T> | undefined {
  const before = new Map(previous.map(item => [item.id, item]));
  const upsert = next.filter(item => JSON.stringify(before.get(item.id)) !== JSON.stringify(item));
  // An order change also describes insertions, deletions and the rolling chat window.
  const reordered = previous.length !== next.length || next.some((item, index) => item.id !== previous[index]?.id);
  return upsert.length || reordered ? { upsert, ...(reordered ? { order: next.map(item => item.id) } : {}) } : undefined;
}

export function diffSnapshot(previous: Snapshot, next: Snapshot): SnapshotPatch | null {
  const { tasks, entries, watches, ...values } = next;
  const changed = Object.fromEntries((Object.keys(values) as (keyof Values)[])
    .filter(key => JSON.stringify(previous[key]) !== JSON.stringify(values[key]))
    .map(key => [key, values[key]]));
  const patch: SnapshotPatch = {};
  if (Object.keys(changed).length) patch.values = changed;
  patch.tasks = diffList(previous.tasks, tasks);
  patch.entries = diffList(previous.entries, entries);
  patch.watches = diffList(previous.watches, watches);
  return patch.values || patch.tasks || patch.entries || patch.watches ? patch : null;
}

function applyList<T extends Identified>(previous: T[], patch?: ListPatch<T>): T[] {
  if (!patch) return previous;
  const items = new Map(previous.map(item => [item.id, item]));
  for (const item of patch.upsert) items.set(item.id, item);
  return (patch.order || previous.map(item => item.id)).map(id => {
    const item = items.get(id);
    if (!item) throw new Error('Snapshot update references an unknown item');
    return item;
  });
}

export function applySnapshotPatch(previous: Snapshot, patch: SnapshotPatch): Snapshot {
  return {
    ...previous, ...patch.values,
    tasks: applyList(previous.tasks, patch.tasks),
    entries: applyList(previous.entries, patch.entries),
    watches: applyList(previous.watches, patch.watches),
  };
}
