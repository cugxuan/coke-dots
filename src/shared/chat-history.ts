import type { ChatHistoryState, Snapshot, VoiceCallSession } from './types.ts';

/** This changes the Dot presentation only; Activity and task detail retain their original data. */
export function visibleChatHistory(snapshot: Snapshot) {
  const history = snapshot.chatHistory;
  if (!history?.clearedAt) return { tasks: snapshot.tasks, entries: snapshot.entries };
  const hidden = new Set(history.hiddenTaskIds);
  return {
    tasks: snapshot.tasks.filter(task => !hidden.has(task.id)),
    entries: snapshot.entries.filter(entry => entry.id > history.entryId && (!entry.taskId || !hidden.has(entry.taskId))),
  };
}

export function visibleCallHistory(calls: VoiceCallSession[], history?: ChatHistoryState) {
  const clearedAt = history?.clearedAt;
  return clearedAt ? calls.filter(call => call.startedAt > clearedAt) : calls;
}
