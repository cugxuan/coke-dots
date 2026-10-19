import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QwenVoiceSession, type QwenVoiceEvent } from '../src/web/qwen-voice-session.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let turn = 0;
  let playback = false;
  const sent: { type: string; item?: { type?: string; call_id?: string; output?: string; content?: { text?: string }[] } }[] = [];
  const records: { id: string; role: string; text: string }[] = [];
  const calls: { name: string; args: unknown; turn: number; id: string }[] = [];
  let runTool = async () => ({ task_id: 'task-1', status: 'queued' });
  const session = new QwenVoiceSession({
    send: event => sent.push(event as typeof sent[number]), beginTurn: () => ++turn, isCurrent: candidate => candidate === turn,
    playback: value => { playback = value; }, status: () => {}, transcript: () => {}, error: () => {},
    record: (id, role, text) => records.push({ id, role, text }),
    tool: async (name, args, input) => { calls.push({ name, args, ...input }); return await runTool(); },
  });
  session.setReady();
  const start = (id: string) => session.handle({ type: 'input_audio_buffer.speech_started', item_id: id });
  const transcript = (id: string, text = '你好') => session.handle({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
  const created = (id: string) => session.handle({ type: 'response.created', response: { id, modalities: ['text', 'audio'] } });
  const done = (id: string, output: NonNullable<QwenVoiceEvent['response']>['output'] = [], status = 'completed') => session.handle({ type: 'response.done', response: { id, status, output } });
  const tool = (callId = 'call-1') => ({ type: 'function_call', call_id: callId, name: 'delegate_task', arguments: '{"instruction":"创建文件"}' });
  return { session, sent, records, calls, start, transcript, created, done, tool,
    get turn() { return turn; }, get playback() { return playback; }, setTool: (fn: typeof runTool) => { runTool = fn; } };
}

test('ordinary native voice answers are recorded once and never dispatch a task', () => {
  const f = fixture();
  f.start('input-1'); f.start('input-1'); f.transcript('input-1'); f.transcript('input-1');
  f.created('direct');
  assert.equal(f.playback, true);
  f.session.handle({ type: 'response.audio_transcript.done', response_id: 'direct', item_id: 'answer', transcript: '你好，有什么需要帮忙？' });
  f.done('direct', [{ id: 'answer', type: 'message', content: [{ transcript: '你好，有什么需要帮忙？' }] }]);
  f.done('direct');
  assert.equal(f.turn, 1);
  assert.deepEqual(f.records.map(record => record.text), ['你好', '你好，有什么需要帮忙？']);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0, 'Native answers need no extra model request');
});

test('complete function events dispatch once, return acceptance before result speech, and preserve source turn', async () => {
  const f = fixture();
  f.start('input-task'); f.created('dispatch');
  f.session.handle({ type: 'response.output_item.added', response_id: 'dispatch', item: { ...f.tool(), arguments: '' } });
  f.session.handle({ type: 'response.function_call_arguments.done', response_id: 'dispatch', call_id: 'call-1', arguments: '{"instruction":"创建文件"}' });
  assert.equal(f.calls.length, 0, 'A cancelled partial response cannot execute');
  f.done('dispatch', [f.tool()]); f.done('dispatch', [f.tool()]);
  f.session.speak('文件已创建。', f.turn);
  await tick();
  assert.deepEqual(f.calls, [{ name: 'delegate_task', args: { instruction: '创建文件' }, turn: 1, id: 'input-task' }]);
  assert.equal(f.sent[0].item?.type, 'function_call_output');
  assert.equal(JSON.parse(f.sent[0].item?.output || '{}').status, 'queued');
  assert.equal(f.sent.filter(event => event.type === 'response.create').length, 1);
  f.created('receipt'); f.done('receipt');
  assert(f.sent.some(event => event.item?.content?.[0]?.text?.includes('文件已创建。')));
});

test('cancelled or superseded function calls cannot create tasks', async () => {
  const f = fixture();
  f.start('old'); f.created('old-response'); f.start('new');
  f.done('old-response', [f.tool()]);
  f.created('new-response'); f.done('new-response', [f.tool('call-2')], 'cancelled');
  await tick();
  assert.equal(f.calls.length, 0);
});

test('a fast direct answer waits for delayed transcription so chat retains user/assistant order', () => {
  const f = fixture();
  f.start('delayed-asr'); f.created('answer');
  f.done('answer', [{ id: 'answer-text', type: 'message', content: [{ transcript: '二。' }] }]);
  assert.equal(f.records.length, 0);
  f.transcript('delayed-asr', '一加一等于几？');
  assert.deepEqual(f.records.map(record => record.role), ['user', 'assistant']);
});

test('tool-based spoken answers are recorded after their input without repeating task-result readouts', async () => {
  const f = fixture();
  f.start('status-input'); f.created('status-tool'); f.done('status-tool', [{ ...f.tool(), name: 'get_task_status' }]);
  await tick();
  f.created('status-answer'); f.done('status-answer', [{ type: 'message', id: 'status-text', content: [{ transcript: '任务还在处理中。' }] }]);
  assert.equal(f.records.length, 0);
  f.transcript('status-input', '进度如何？');
  assert.deepEqual(f.records.map(record => record.text), ['进度如何？', '任务还在处理中。']);
  f.session.speak('完整结果已经保存在聊天中。', f.turn);
  f.created('readout'); f.done('readout', [{ type: 'message', content: [{ transcript: '完整结果已经保存在聊天中。' }] }]);
  assert.equal(f.records.length, 2);
});

test('late task acceptance stays silent while a new direct answer can play', async () => {
  const f = fixture();
  let release!: (value: { task_id: string; status: string }) => void;
  f.setTool(() => new Promise(resolve => { release = resolve; }));
  f.start('old'); f.created('old-response'); f.done('old-response', [f.tool()]);
  f.start('new'); f.created('new-response');
  assert.equal(f.playback, true);
  release({ task_id: 'task-1', status: 'queued' }); await tick();
  f.done('new-response');
  assert.equal(f.sent.filter(event => event.type === 'response.create').length, 0);
  assert.equal(f.sent.filter(event => event.item?.type === 'function_call_output').length, 1, 'Close the old tool call without speaking its receipt');
});

test('interruption drops queued results and old cancellation cannot consume a fresh input', () => {
  const f = fixture();
  f.start('old'); f.created('old-response'); f.session.speak('旧结果', 1);
  f.start('new'); f.start('new');
  assert.equal(f.playback, false);
  f.created('new-response');
  f.done('old-response', [], 'cancelled'); f.done('old-response', [], 'cancelled');
  f.done('new-response'); f.session.speak('新结果', 2);
  assert.equal(f.sent.filter(event => event.type === 'response.create').length, 1);
  assert(!JSON.stringify(f.sent).includes('旧结果'));
  assert(JSON.stringify(f.sent).includes('新结果'));
});

test('a late response.created for interrupted explicit speech cannot reopen audio', () => {
  const f = fixture();
  f.session.speak('开场白', 0);
  f.start('new'); f.created('late-greeting');
  assert.equal(f.playback, false);
  f.done('late-greeting', [], 'cancelled');
  f.created('new-answer'); assert.equal(f.playback, true);
});

test('an unknown old cancellation cannot consume a new input or unmute residual audio', () => {
  const f = fixture();
  f.start('fresh'); f.done('unknown-old', [], 'cancelled');
  assert.equal(f.playback, false);
  f.created('fresh-response'); assert.equal(f.playback, true);
  f.transcript('fresh'); f.done('fresh-response');
  assert.equal(f.records[0].id, 'fresh');
});

test('malformed tool JSON returns a recoverable tool error without dispatch', async () => {
  const f = fixture();
  f.start('input'); f.created('response'); f.done('response', [{ ...f.tool(), arguments: 'not-json' }]);
  await tick();
  assert.equal(f.calls.length, 0);
  assert(JSON.parse(f.sent[0].item?.output || '{}').error);
});

test('failed transcription releases a pending input and interrupted explicit requests cannot dispatch', async () => {
  const f = fixture();
  f.start('failed');
  f.session.handle({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'failed' });
  f.session.speak('请重试', f.turn); f.created('speech'); f.done('speech', [f.tool()]);
  await tick();
  assert.equal(f.calls.length, 0);
});
