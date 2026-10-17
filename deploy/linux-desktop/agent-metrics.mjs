// Monotonic phase durations, never model payloads, prompts or private reasoning.
export function createRunMetrics(emit, now = () => performance.now()) {
  const began = now();
  const totals = { startupMs: 0, modelMs: 0, toolMs: 0, browserMs: 0, pageWaitMs: 0, modelCalls: 0, toolCalls: 0, compactions: 0, compactionMs: 0, contextTokens: 0 };
  let modelStart;
  let pendingModels = 0;
  let toolsStart;
  let compactionStart;
  const tools = new Set();
  const models = new WeakSet();
  const snapshot = () => Object.fromEntries(Object.entries({ ...totals, runtimeMs: now() - began }).map(([key, value]) => [key, Math.max(0, Math.round(value))]));
  const publish = () => emit?.({ id: 'runtime-metrics', kind: 'metrics', message: '执行耗时', timing: snapshot() });
  return {
    snapshot,
    get compacting() { return compactionStart !== undefined; },
    ready() { totals.startupMs = now() - began; publish(); },
    modelStarted() { modelStart ??= now(); pendingModels++; totals.modelCalls++; publish(); },
    browserFinished(detail) {
      if (Number.isFinite(detail.durationMs)) totals.browserMs += detail.durationMs;
      if (Number.isFinite(detail.pageWaitMs)) totals.pageWaitMs += detail.pageWaitMs;
    },
    event(event) {
      if (event.type === 'message_end' && event.message?.role === 'assistant' && !models.has(event.message)) {
        models.add(event.message);
        pendingModels = Math.max(0, pendingModels - 1);
        if (!pendingModels && modelStart !== undefined) { totals.modelMs += now() - modelStart; modelStart = undefined; }
        const u = event.message.usage;
        if (u) totals.contextTokens = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
        publish();
      }
      if (event.type === 'tool_execution_start') {
        if (!tools.size) toolsStart = now();
        tools.add(event.toolCallId); totals.toolCalls++;
      }
      if (event.type === 'tool_execution_end') {
        tools.delete(event.toolCallId);
        if (!tools.size && toolsStart !== undefined) { totals.toolMs += now() - toolsStart; toolsStart = undefined; }
        publish();
      }
      if (event.type === 'compaction_start') { compactionStart = now(); totals.compactions++; }
      if (event.type === 'compaction_end' && compactionStart !== undefined) { totals.compactionMs += now() - compactionStart; compactionStart = undefined; publish(); }
    },
    finish() {
      if (modelStart !== undefined) totals.modelMs += now() - modelStart;
      if (toolsStart !== undefined) totals.toolMs += now() - toolsStart;
      modelStart = undefined; toolsStart = undefined;
      publish(); return snapshot();
    },
  };
}
