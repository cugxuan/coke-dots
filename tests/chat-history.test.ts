import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/store.ts';
import { ChatMessages, type ChatSubmission } from '../src/server/chat-messages.ts';
import { visibleCallHistory, visibleChatHistory } from '../src/shared/chat-history.ts';

const input = (instruction: string, extra: Partial<ChatSubmission> = {}): ChatSubmission => ({ messageId: randomUUID(), instruction, mode: 'auto', engine: 'model', attachmentIds: [], ...extra });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dots-chat-history-'));
  const store = new Store(dir);
  const owner = store.signInGoogle({ subject: 'owner', email: 'owner@example.test', name: 'Owner' });
  const file = store.addPendingAttachment(owner.tenant.id, owner.user.id, 'report.csv', 'text/csv', Buffer.from('name,value\nreport,42'));
  const task = store.createTask('整理原始报告', null, 'model', owner.tenant.id, null, null, [file.id], owner.user.id);
  store.updateTask(task.id, { status: 'done', result: 'report.csv 已完成', agentSessionId: 'original-session' });
  store.addEntry('dot', '原始报告内容', task.id, owner.tenant.id);
  const call = store.createVoiceCall(owner.tenant.id, owner.user.id);
  store.endVoiceCall(owner.tenant.id, owner.user.id, call.id, 10);
  return { dir, store, owner, task, file, call, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('clearing hides Dot history and late results, while tasks, files, entries and calls remain intact', async () => {
  const f = fixture();
  try {
    const chat = new ChatMessages(f.store, async () => { throw new Error('An empty conversation must not classify against old tasks'); });
    const beforeTask = f.store.getTask(f.task.id);
    const beforeFiles = f.store.db.prepare('SELECT * FROM task_attachments').all();
    const beforeEntries = f.store.db.prepare('SELECT * FROM entries').all();
    const beforeCalls = f.store.voiceCalls(f.owner.tenant.id, f.owner.user.id);
    const history = chat.clearHistory(f.owner.tenant.id, f.owner.user.id);
    const view = () => visibleChatHistory({ ...f.store.snapshot(false, [], undefined, f.owner.tenant.id), chatHistory: chat.history(f.owner.tenant.id, f.owner.user.id) });
    assert.equal(history.revision, 1);
    assert.deepEqual(view(), { tasks: [], entries: [] });
    assert.deepEqual(visibleCallHistory(beforeCalls, history), []);
    assert.deepEqual(f.store.getTask(f.task.id), beforeTask);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM task_attachments').all(), beforeFiles);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM entries').all(), beforeEntries);
    assert.deepEqual(f.store.voiceCalls(f.owner.tenant.id, f.owner.user.id), beforeCalls);
    assert.deepEqual(chat.context(f.owner.tenant.id, f.owner.user.id).candidates, []);

    f.store.addEntry('dot', '清除后才到达的旧任务结果', f.task.id, f.owner.tenant.id);
    assert.deepEqual(view(), { tasks: [], entries: [] });
    const fresh = await chat.submit(f.owner.tenant.id, f.owner.user.id, input('从干净对话开始'));
    assert.equal(fresh.status, 'submitted');
    if (fresh.status !== 'submitted') throw new Error('Missing task');
    assert.equal(fresh.routing, 'new');
    assert.notEqual(fresh.task.id, f.task.id);
    assert.deepEqual(view().tasks.map(task => task.id), [fresh.task.id]);
    assert(view().entries.every(entry => entry.taskId === fresh.task.id));

    const resumed = await chat.submit(f.owner.tenant.id, f.owner.user.id, input('手动打开旧报告继续', { mode: 'continue', taskId: f.task.id }));
    assert.equal(resumed.status, 'submitted');
    if (resumed.status !== 'submitted') throw new Error('Missing continuation');
    assert.equal(resumed.task.agentSessionId, 'original-session');
    assert.equal(resumed.task.instruction, f.task.instruction);
    assert(view().tasks.some(task => task.id === f.task.id));
    assert(view().entries.some(entry => entry.body === '手动打开旧报告继续'));
    assert(!view().entries.some(entry => entry.body === '原始报告内容'));
    assert.equal(chat.context(f.owner.tenant.id, f.owner.user.id).candidates[0].id, f.task.id);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM task_attachments').all(), beforeFiles);
  } finally { f.close(); }
});

test('clear state persists across restart and is isolated by both account and workspace', () => {
  const f = fixture();
  try {
    const other = f.store.signInGoogle({ subject: 'other', email: 'other@example.test', name: 'Other' });
    f.store.db.prepare('INSERT INTO memberships(tenant_id,user_id,role,created_at) VALUES (?,?,?,?)').run(f.owner.tenant.id, other.user.id, 'member', new Date().toISOString());
    const chat = new ChatMessages(f.store);
    const cleared = chat.clearHistory(f.owner.tenant.id, f.owner.user.id);
    assert.equal(chat.history(f.owner.tenant.id, other.user.id).clearedAt, null);
    assert.equal(chat.history(other.tenant.id, other.user.id).clearedAt, null);
    assert.throws(() => chat.clearHistory(other.tenant.id, f.owner.user.id), /工作区不可用/);
    f.store.close();
    const reopened = new Store(f.dir);
    try {
      const saved = new ChatMessages(reopened);
      assert.deepEqual(saved.history(f.owner.tenant.id, f.owner.user.id), cleared);
      assert.equal(saved.context(f.owner.tenant.id, f.owner.user.id).focusTaskId, null);
      assert.equal(saved.history(f.owner.tenant.id, other.user.id).clearedAt, null);
      assert.equal(reopened.getTask(f.task.id)?.agentSessionId, 'original-session');
    } finally { reopened.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('clearing invalidates an automatic routing decision already in flight', async () => {
  const f = fixture();
  try {
    let finish!: () => void;
    const chat = new ChatMessages(f.store, async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { action: 'continue', taskId: f.task.id, reason: 'follow-up' };
    });
    const pending = chat.submit(f.owner.tenant.id, f.owner.user.id, input('继续之前的报告'));
    chat.clearHistory(f.owner.tenant.id, f.owner.user.id);
    finish();
    await assert.rejects(pending, /切换了话题/);
    assert.equal(f.store.getTask(f.task.id)?.status, 'done');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_message_receipts').get()?.n, 0);
  } finally { f.close(); }
});

test('calls started before clearing stay hidden when they end later; new calls remain visible', () => {
  const f = fixture();
  try {
    const ongoing = f.store.createVoiceCall(f.owner.tenant.id, f.owner.user.id);
    const history = new ChatMessages(f.store).clearHistory(f.owner.tenant.id, f.owner.user.id);
    const later = new Date(Date.parse(history.clearedAt!) + 1000).toISOString();
    f.store.endVoiceCall(f.owner.tenant.id, f.owner.user.id, ongoing.id, 5, later);
    const fresh = f.store.createVoiceCall(f.owner.tenant.id, f.owner.user.id, later);
    f.store.endVoiceCall(f.owner.tenant.id, f.owner.user.id, fresh.id, 5, later);
    assert.deepEqual(visibleCallHistory(f.store.voiceCalls(f.owner.tenant.id, f.owner.user.id), history).map(call => call.id), [fresh.id]);
    assert.equal(f.store.voiceCalls(f.owner.tenant.id, f.owner.user.id).length, 3);
  } finally { f.close(); }
});
