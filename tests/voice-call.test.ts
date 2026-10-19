import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';

test('secretary conversations persist without tasks, link delegated input in either event order, and enforce call ownership', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-secretary-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'secretary-alpha', email: 'secretary-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'secretary-beta', email: 'secretary-beta@example.test', name: 'Beta' });
    const call = store.createVoiceCall(alpha.tenant.id, alpha.user.id);
    const record = (id: string, role: 'user' | 'assistant', text: string) => store.recordVoiceMessage(alpha.tenant.id, alpha.user.id, call.id, id, role, text);
    record('greeting', 'user', '你好'); record('answer', 'assistant', '你好，有什么需要帮忙？');
    assert.equal(record('greeting', 'user', '重复').duplicate, true);
    assert.equal(store.snapshot(false, [], undefined, alpha.tenant.id).tasks.length, 0);
    assert.throws(() => store.recordVoiceMessage(beta.tenant.id, beta.user.id, call.id, 'greeting', 'user', '你好'), /语音通话不存在/);
    assert.throws(() => store.recordVoiceMessage(alpha.tenant.id, beta.user.id, call.id, 'greeting', 'user', '你好'), /语音通话不存在/);
    for (const messageFirst of [true, false]) {
      const id = `input-${messageFirst}`;
      if (messageFirst) record(id, 'user', '帮我创建文件');
      const request = { tenantId: alpha.tenant.id, userId: alpha.user.id, callId: call.id, turnId: id, sourceMessageId: id, transcript: '创建文件，内容为前文约定的文字', engine: 'pi' as const };
      const { task } = store.submitVoiceTurn(request);
      if (!messageFirst) record(id, 'user', '帮我创建文件');
      assert.equal(store.submitVoiceTurn(request).task.id, task.id);
      const entries = store.snapshot(false, [], undefined, alpha.tenant.id).entries.filter(entry => entry.taskId === task.id && entry.kind === 'user');
      assert.deepEqual(entries.map(entry => entry.body), ['帮我创建文件']);
      assert.equal(store.voiceCallTask(alpha.tenant.id, alpha.user.id, call.id, task.id)?.id, task.id);
      assert.equal(store.voiceCallTask(alpha.tenant.id, beta.user.id, call.id, task.id), null);
      store.updateTask(task.id, { status: 'waiting' }, alpha.tenant.id);
      assert.equal(store.submitVoiceTurn({ ...request, turnId: id + '-reply', sourceMessageId: id + '-reply', waitingTaskId: task.id, transcript: '周五' }).task.id, task.id);
    }
    const unrelated = store.createTask('其他任务', null, 'pi', alpha.tenant.id);
    store.updateTask(unrelated.id, { status: 'waiting' }, alpha.tenant.id);
    assert.throws(() => store.submitVoiceTurn({ tenantId: alpha.tenant.id, userId: alpha.user.id, callId: call.id, turnId: 'invalid', sourceMessageId: 'invalid', waitingTaskId: unrelated.id, transcript: '周五', engine: 'pi' }), /本次通话没有该任务/);
    store.endVoiceCall(alpha.tenant.id, alpha.user.id, call.id, 10); store.close();
    store = new Store(directory);
    assert.equal(record('answer', 'assistant', 'duplicate').duplicate, true);
    assert.throws(() => record('late', 'assistant', '迟到消息'), /语音通话已结束/);
    assert.equal(store.snapshot(false, [], undefined, alpha.tenant.id).entries.filter(entry => entry.body === '你好，有什么需要帮忙？').length, 1);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('voice call history is durable and scoped to its workspace and owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-voice-call-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'voice-alpha', email: 'voice-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'voice-beta', email: 'voice-beta@example.test', name: 'Beta' });
    const startedAt = '2026-10-06T03:00:00.000Z';
    const call = store.createVoiceCall(alpha.tenant.id, alpha.user.id, startedAt);

    assert.equal(call.tenantId, alpha.tenant.id);
    assert.equal(call.startedAt, startedAt);
    assert.equal(call.endedAt, null);
    assert.deepEqual(store.getVoiceCall(alpha.tenant.id, alpha.user.id, call.id), call);
    assert.equal(store.getVoiceCall(beta.tenant.id, beta.user.id, call.id), null, 'A different tenant and owner must not inspect this call');
    assert.deepEqual(store.voiceCalls(beta.tenant.id, beta.user.id), []);
    assert.equal(store.endVoiceCall(beta.tenant.id, beta.user.id, call.id, 12), null, 'A different tenant must not end this call');
    assert.deepEqual(store.voiceCalls(alpha.tenant.id, alpha.user.id), [call]);

    const ended = store.endVoiceCall(alpha.tenant.id, alpha.user.id, call.id, 12, '2026-10-06T03:00:12.000Z');
    assert.deepEqual(ended, { ...call, endedAt: '2026-10-06T03:00:12.000Z', durationSeconds: 12 });
    assert.deepEqual(store.endVoiceCall(alpha.tenant.id, alpha.user.id, call.id, 99, '2026-10-06T03:01:39.000Z'), ended,
      'A repeated hangup must preserve the first end time and duration');
    // Exercise migration from the schema that predates call creation keys.
    store.db.exec('DROP INDEX voice_calls_request; ALTER TABLE voice_calls DROP COLUMN request_id');
    store.close();

    store = new Store(directory);
    assert.deepEqual(store.voiceCalls(alpha.tenant.id, alpha.user.id), [ended]);
    assert.deepEqual(store.voiceCalls(beta.tenant.id, beta.user.id), []);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('call creation retries reuse one durable record without merging separate calls or owners', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-call-request-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'call-request-alpha', email: 'call-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'call-request-beta', email: 'call-beta@example.test', name: 'Beta' });
    const start = '2026-10-19T03:00:00.000Z';
    const requestId = 'same-call-request';
    const call = store.createVoiceCall(alpha.tenant.id, alpha.user.id, start, requestId);
    assert.deepEqual(store.createVoiceCall(alpha.tenant.id, alpha.user.id, undefined, requestId), call);
    assert.notEqual(store.createVoiceCall(beta.tenant.id, beta.user.id, start, requestId).id, call.id);
    assert.notEqual(store.createVoiceCall(alpha.tenant.id, beta.user.id, start, requestId).id, call.id,
      'Another member cannot collide with an owner’s key');
    assert.notEqual(store.createVoiceCall(alpha.tenant.id, alpha.user.id, start, 'next-call-request').id, call.id,
      'Two intentional calls at the same time must remain distinct');
    const legacy = store.createVoiceCall(alpha.tenant.id, alpha.user.id, start);
    assert.notEqual(store.createVoiceCall(alpha.tenant.id, alpha.user.id, start).id, legacy.id,
      'Older clients without keys still create independent calls');
    const ended = store.endVoiceCall(alpha.tenant.id, alpha.user.id, call.id, 65, '2026-10-19T03:01:05.000Z');
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.createVoiceCall(alpha.tenant.id, alpha.user.id, undefined, requestId), ended,
      'A delayed creation retry after restart/hangup must not reopen or duplicate the call');
    assert.equal(store.voiceCalls(alpha.tenant.id, alpha.user.id).length, 4);
    assert.throws(() => store.createVoiceCall(alpha.tenant.id, alpha.user.id, start, ''), /通话请求 ID 无效/);
    assert.throws(() => store.createVoiceCall(alpha.tenant.id, alpha.user.id, start, 'x'.repeat(129)), /通话请求 ID 无效/);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('voice turn dispatch is durable, owner-scoped, and idempotent across task creation and call retries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-voice-turn-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'voice-turn-alpha', email: 'voice-turn-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'voice-turn-beta', email: 'voice-turn-beta@example.test', name: 'Beta' });
    const call = store.createVoiceCall(alpha.tenant.id, alpha.user.id);
    const request = {
      tenantId: alpha.tenant.id, userId: alpha.user.id, callId: call.id,
      turnId: 'item-qwen-turn-1', transcript: '整理今天的工作进展', engine: 'pi' as const,
    };

    const first = store.submitVoiceTurn(request);
    const duplicate = store.submitVoiceTurn({ ...request, transcript: '重复送达的同一轮语音' });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.task.id, first.task.id);
    assert.equal(duplicate.task.instruction, '整理今天的工作进展');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM voice_call_turns WHERE call_id=?').get(call.id) as { count: number }).count, 1);
    assert.equal(store.getTask(first.task.id, beta.tenant.id), null);
    assert.throws(() => store.submitVoiceTurn({ ...request, tenantId: beta.tenant.id, userId: beta.user.id }), /语音通话不存在/);

    assert.equal(store.voiceCallTaskText(alpha.tenant.id, alpha.user.id, call.id, first.task.id), null, 'Queued work is not a completed result');
    store.updateTask(first.task.id, { status: 'done', result: '已完成，17 条记录。' }, alpha.tenant.id);
    assert.equal(store.voiceCallTaskText(alpha.tenant.id, alpha.user.id, call.id, first.task.id), '已完成，17 条记录。');
    assert.equal(store.voiceCallTaskText(beta.tenant.id, beta.user.id, call.id, first.task.id), null);
    assert.equal(store.voiceCallTaskText(alpha.tenant.id, beta.user.id, call.id, first.task.id), null, 'Another user in the same workspace cannot request this call’s speech');
    const unrelated = store.createTask('其他任务', null, 'pi', alpha.tenant.id);
    store.updateTask(unrelated.id, { status: 'done', result: '其他任务的结果' }, alpha.tenant.id);
    assert.equal(store.voiceCallTaskText(alpha.tenant.id, alpha.user.id, call.id, unrelated.id), null);
    store.updateTask(first.task.id, { status: 'waiting' }, alpha.tenant.id);
    store.addEntry('dot', '请告诉我日期。', first.task.id, alpha.tenant.id);
    assert.equal(store.voiceCallTaskText(alpha.tenant.id, alpha.user.id, call.id, first.task.id), '请告诉我日期。', 'A clarification must not read a stale completed result');

    store.endVoiceCall(alpha.tenant.id, alpha.user.id, call.id, 10);
    store.close();
    store = new Store(directory);
    const retryAfterHangup = store.submitVoiceTurn(request);
    assert.equal(retryAfterHangup.duplicate, true, 'A retry may recover the already-created task after hangup');
    assert.equal(retryAfterHangup.task.id, first.task.id);
    assert.throws(() => store.submitVoiceTurn({ ...request, turnId: 'item-qwen-turn-2' }), /语音通话已结束/);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a repeated voice reply resumes a waiting task exactly once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-voice-reply-'));
  try {
    const store = new Store(directory);
    const user = store.signInGoogle({ subject: 'voice-reply-user', email: 'voice-reply@example.test', name: 'Voice User' });
    const call = store.createVoiceCall(user.tenant.id, user.user.id);
    const waiting = store.createTask('请告诉我会议日期', null, 'pi', user.tenant.id);
    store.updateTask(waiting.id, { status: 'waiting', nextRunAt: null }, user.tenant.id);
    const request = {
      tenantId: user.tenant.id, userId: user.user.id, callId: call.id,
      turnId: 'item-qwen-reply-1', transcript: '周五', engine: 'pi' as const, waitingTaskId: waiting.id,
    };

    const first = store.submitVoiceTurn(request);
    const duplicate = store.submitVoiceTurn(request);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.task.id, waiting.id);
    assert.equal(duplicate.task.status, 'queued');
    assert.equal(duplicate.task.instruction.match(/User reply: 周五/g)?.length, 1);
    const replies = store.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE tenant_id=? AND task_id=? AND kind='user' AND body=?")
      .get(user.tenant.id, waiting.id, '周五') as { count: number };
    assert.equal(replies.count, 1);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
