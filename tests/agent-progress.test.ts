import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiProgressReporter, normalizeProgress, tokenUsage, progressText } from '../deploy/linux-desktop/agent-progress.mjs';
import { readAgentResponse } from '../src/server/agent-progress-stream.ts';
import { Store } from '../src/server/store.ts';
import type { AgentProgress } from '../src/shared/types.ts';

test('Pi reports live tool work and per-response usage without exposing private reasoning or credentials', () => {
  const events: AgentProgress[] = [];
  const report = createPiProgressReporter(event => events.push(event), ['provider-private-key', 'bridge-private-key']);
  report({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', partial: { thinking: 'private-chain' } } });
  report({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'private-chain' } });
  report({ type: 'tool_execution_start', toolCallId: 'tool1', toolName: 'bash', args: { command: 'echo provider-private-key token=bridge-private-key', arbitrary: 'hidden' } });
  report({ type: 'tool_execution_update', toolCallId: 'tool1', partialResult: { content: [{ type: 'text', text: 'step one' }] } });
  report({ type: 'tool_execution_end', toolCallId: 'tool1', isError: true, result: { content: [{ type: 'text', text: 'failed Authorization: Bearer credential' }] } });
  const message = { role: 'assistant', usage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 2, totalTokens: 35 }, content: [{ type: 'thinking', thinking: 'private-chain' }, { type: 'text', text: '正在检查结果' }, { type: 'toolCall', id: 't' }] };
  report({ type: 'message_end', message }); report({ type: 'message_end', message });
  report({ type: 'message_end', message: { role: 'assistant', usage: { input: 5, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 9 }, content: [{ type: 'text', text: '{"status":"done","message":"final"}' }] } });
  assert(events.some(event => event.state === 'running' && event.kind === 'tool'));
  assert(events.some(event => event.detail?.includes('step one')));
  assert(events.some(event => event.state === 'failed'));
  assert.equal(events.filter(event => event.kind === 'usage').length, 2);
  assert.deepEqual(events.filter(event => event.kind === 'usage').at(-1)?.usage, { input: 37, output: 7, cacheRead: 20, cacheWrite: 2, total: 44 });
  assert(events.some(event => event.detail === '正在检查结果'));
  assert.doesNotMatch(JSON.stringify(events), /private-chain|provider-private-key|bridge-private-key|credential|arbitrary|"final"/);
});

test('missing usage stays unknown and cache accounting follows the provider format', () => {
  assert.equal(tokenUsage(undefined), undefined);
  assert.equal(tokenUsage({}), undefined);
  assert.equal(tokenUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }), undefined, 'Pi initializes unreported usage to zero');
  assert.doesNotMatch(progressText('{"apiKey": "hidden-key", "password": "hidden two words", "token":"hidden-token"}'), /hidden/);
  assert.equal(tokenUsage({ input: -1, output: 3 }), undefined);
  assert.deepEqual(tokenUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 70 } }, 'completions'), { input: 100, output: 20, cacheRead: 70, cacheWrite: 0, total: 120 });
  assert.deepEqual(tokenUsage({ input: 30, output: 20, cacheRead: 70, cacheWrite: 0 }), { input: 100, output: 20, cacheRead: 70, cacheWrite: 0, total: 120 });
  assert.equal(normalizeProgress({ id: 'usage', kind: 'usage', message: 'usage', usage: { input: Infinity } }), null);
});

test('stream reader delivers progress before completion, survives UTF-8 splits, and accepts legacy JSON', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const events: AgentProgress[] = [];
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  let finished = false;
  const result = readAgentResponse(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), event => events.push(event)).then(value => { finished = true; return value; });
  const bytes = new TextEncoder().encode(JSON.stringify({ type: 'progress', event: { id: 'phase', kind: 'status', message: '正在执行中文任务' } }) + '\n\n');
  for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events[0]?.message, '正在执行中文任务'); assert.equal(finished, false);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'result', result: { status: 'done', message: 'ok' } })));
  controller.close();
  assert.equal((await result).message, 'ok');
  assert.deepEqual(await readAgentResponse(Response.json({ status: 'done', message: 'old runtime' })), { status: 'done', message: 'old runtime' });
});

test('stream reader rejects interrupted runs and explicit errors instead of claiming completion', async () => {
  const response = (text: string) => new Response(text, { headers: { 'content-type': 'application/x-ndjson' } });
  await assert.rejects(readAgentResponse(response('\n')), /未收到最终结果/);
  await assert.rejects(readAgentResponse(response('{"type":"error","error":"adapter failed"}\n')), /adapter failed/);
  await assert.rejects(readAgentResponse(response('x'.repeat(513_000))), /过大/);
});

test('execution survives reopen, scopes updates by tenant and run, and counts usage once across retries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dots-progress-'));
  let store = new Store(directory);
  const usage: AgentProgress = { id: 'usage', kind: 'usage', message: '模型用量', usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, total: 120 } };
  try {
    const task = store.createTask('progress test');
    store.updateTask(task.id, { status: 'working' });
    const run = store.beginTaskExecution(task.id, 'legacy');
    assert.equal(store.recordTaskProgress(task.id, 'other-tenant', run, usage), false);
    assert.equal(store.recordTaskProgress(task.id, 'legacy', 'stale-run', usage), false);
    assert.equal(store.recordTaskProgress(task.id, 'legacy', run, usage), true);
    store.recordTaskProgress(task.id, 'legacy', run, usage);
    store.recordTaskProgress(task.id, 'legacy', run, { id: 'metrics', kind: 'metrics', message: 'Timing', timing: { modelMs: 100, modelCalls: 1 } });
    store.recordTaskProgress(task.id, 'legacy', run, { id: 'dispatch', kind: 'metrics', message: 'Timing', timing: { dispatchMs: 25 } });
    store.recordTaskProgress(task.id, 'legacy', run, { id: 'tool:1', kind: 'tool', message: 'bash', state: 'running' });
    store.updateTask(task.id, { status: 'paused' });
    assert.equal(store.recordTaskProgress(task.id, 'legacy', run, usage), false);
    store.finishTaskExecution(task.id, 'legacy', run);
    assert.equal(store.getTask(task.id)?.execution?.events[0]?.state, 'interrupted');
    store.close(); store = new Store(directory);
    assert.equal(store.getTask(task.id)?.execution?.totalUsage?.total, 120);
    assert.deepEqual(store.getTask(task.id)?.execution?.timing, { modelMs: 100, modelCalls: 1, dispatchMs: 25 });
    store.updateTask(task.id, { status: 'working' });
    const retry = store.beginTaskExecution(task.id, 'legacy');
    assert.equal(store.getTask(task.id)?.execution?.usage, undefined);
    assert.equal(store.getTask(task.id)?.execution?.timing, undefined);
    store.recordTaskProgress(task.id, 'legacy', retry, usage);
    assert.equal(store.getTask(task.id)?.execution?.totalUsage?.total, 240);
    assert.equal(store.recordTaskProgress(task.id, 'legacy', run, usage), false);
    for (let i = 0; i < 100; i++) store.recordTaskProgress(task.id, 'legacy', retry, { id: `tool:${i}`, kind: 'tool', message: 'read', state: 'done' });
    assert.equal(store.getTask(task.id)?.execution?.events.length, 50);
    assert.equal(store.snapshot(false).tasks[0].execution?.runs, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
