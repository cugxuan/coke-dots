import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunMetrics } from '../deploy/linux-desktop/agent-metrics.mjs';
import { normalizeProgress } from '../deploy/linux-desktop/agent-progress.mjs';

test('phase accounting measures model waits and overlapping tool wall time without double counting', () => {
  let clock = 0;
  const events = [];
  const metrics = createRunMetrics(event => events.push(event), () => clock);
  clock = 20; metrics.ready(); metrics.modelStarted();
  clock = 1020;
  const message = { role: 'assistant', usage: { input: 30, cacheRead: 20, cacheWrite: 5 } };
  metrics.event({ type: 'message_end', message });
  metrics.event({ type: 'message_end', message });
  metrics.event({ type: 'tool_execution_start', toolCallId: 'a' });
  clock = 1120; metrics.event({ type: 'tool_execution_start', toolCallId: 'b' });
  clock = 1220; metrics.browserFinished({ durationMs: 200, pageWaitMs: 50 });
  metrics.event({ type: 'tool_execution_end', toolCallId: 'a', toolName: 'browser_execute' });
  clock = 1320; metrics.event({ type: 'tool_execution_end', toolCallId: 'b' });
  metrics.modelStarted(); clock = 1620;
  const result = metrics.finish();
  assert.equal(result.modelMs, 1300);
  assert.equal(result.toolMs, 300);
  assert.equal(result.browserMs, 200);
  assert.equal(result.pageWaitMs, 50);
  assert.equal(result.modelCalls, 2);
  assert.equal(result.contextTokens, 55);
  assert.equal(result.runtimeMs, 1620);
  assert.equal(result.startupMs, 20);
  assert.deepEqual(normalizeProgress(events.at(-1)).timing, result);
});

test('public metrics accept only finite nonnegative counts and never forward arbitrary payload fields', () => {
  const result = normalizeProgress({ id: 'metrics', kind: 'metrics', message: 'Timing', timing: { modelMs: 1000, modelCalls: 1, queueMs: -1, toolMs: NaN, browserMs: Infinity, prompt: 'private', apiKey: 'secret' } });
  assert.deepEqual(result.timing, { modelMs: 1000, modelCalls: 1 });
  assert.equal(normalizeProgress({ id: 'metrics', kind: 'metrics', message: 'Timing', timing: { modelMs: '1000' } }), null);
});
