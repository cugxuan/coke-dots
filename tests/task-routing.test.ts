import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { ChatMessages, parseChatSubmission, type ChatSubmission } from '../src/server/chat-messages.ts';
import { parseTaskRoute, selectRoutingCandidates, type RoutingCandidate } from '../src/server/task-routing.ts';
import { adapters, formatAgentPrompt, type AgentRequest } from '../src/server/adapters.ts';
import { taskEvidenceContext } from '../src/server/task-context.ts';
import { Worker } from '../src/server/worker.ts';

const message = (instruction: string, extra: Partial<ChatSubmission> = {}): ChatSubmission => ({ messageId: randomUUID(), instruction, mode: 'auto', engine: 'model', attachmentIds: [], ...extra });
const followup = '帮我列出来具体有哪些信息渠道查询了，哪些没有查询';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dots-routing-'));
  const store = new Store(directory);
  const owner = store.signInGoogle({ subject: 'owner', email: 'owner@example.test', name: 'Owner' });
  const report = store.createTask('请查询比亚迪近三年的公开信用信息并生成报告', null, 'model', owner.tenant.id, null, null, [], owner.user.id);
  store.updateTask(report.id, { status: 'done', result: '比亚迪报告已完成。文件：report.csv、research/notes.md；部分渠道待补查。', agentSessionId: 'byd-native-session' }, owner.tenant.id);
  store.addEntry('dot', '比亚迪报告已完成；报告文件 report.csv，查询笔记 research/notes.md。', report.id, owner.tenant.id);
  return { directory, store, owner, report, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('implicit BYD follow-up continues the original session and retains report, history, identity and files', async () => {
  const f = fixture();
  let modelCalls = 0;
  const chat = new ChatMessages(f.store, async (_tenant, text, context) => {
    modelCalls++;
    assert.equal(text, followup);
    assert.equal(context.focusTaskId, f.report.id);
    assert.match(context.candidates[0].summary, /report.csv/);
    return { action: 'continue', taskId: f.report.id, reason: '追问刚完成的比亚迪报告的渠道覆盖' };
  });
  try {
    const input = message(followup);
    const result = await chat.submit(f.owner.tenant.id, f.owner.user.id, input);
    assert.equal(result.status, 'submitted');
    if (result.status !== 'submitted') throw new Error('Missing submission');
    assert.equal(result.routing, 'continued');
    assert.equal(result.task.id, f.report.id);
    assert.equal(result.task.agentSessionId, 'byd-native-session');
    assert.equal(result.task.instruction, f.report.instruction);
    assert.equal(result.task.followupMessage, followup);
    assert.match(result.task.result!, /report.csv/);
    assert.equal(f.store.snapshot(false, [], undefined, f.owner.tenant.id).tasks.length, 1);
    assert.deepEqual(await chat.submit(f.owner.tenant.id, f.owner.user.id, input), result);
    assert.equal(modelCalls, 1, 'A retry must not classify or enqueue twice');
    assert.equal(f.store.snapshot(false, [], undefined, f.owner.tenant.id).entries.filter(entry => entry.body === followup).length, 1);
    assert.match(JSON.stringify(taskEvidenceContext(f.store, result.task)), /report.csv/);
    await assert.rejects(chat.submit(f.owner.tenant.id, f.owner.user.id, { ...input, instruction: 'changed payload' }), /同一消息编号/);
  } finally { f.close(); }
});

test('explicit selection bypasses model; unrelated new messages create a separate task', async () => {
  const f = fixture();
  let calls = 0;
  const chat = new ChatMessages(f.store, async () => { calls++; return { action: 'new', reason: '天气问题是新话题' }; });
  try {
    const same = await chat.submit(f.owner.tenant.id, f.owner.user.id, message('总结报告', { mode: 'continue', taskId: f.report.id }));
    assert.equal(same.status, 'submitted'); assert.equal(calls, 0);
    const fresh = await chat.submit(f.owner.tenant.id, f.owner.user.id, message('明天深圳天气怎么样'));
    assert.equal(calls, 1); assert.equal(fresh.status, 'submitted');
    if (fresh.status === 'submitted') { assert.notEqual(fresh.task.id, f.report.id); assert.equal(fresh.task.agentSessionId, null); }
    const explicit = await chat.submit(f.owner.tenant.id, f.owner.user.id, message('单独研究宁德时代', { mode: 'new' }));
    assert.equal(explicit.status, 'submitted'); assert.equal(calls, 1);
  } finally { f.close(); }
});

test('ambiguous, unavailable and malformed routing never create tasks or consume attachments', async () => {
  const f = fixture();
  try {
    const file = f.store.addPendingAttachment(f.owner.tenant.id, f.owner.user.id, 'notes.txt', 'text/plain', Buffer.from('source evidence'));
    for (const classify of [async () => ({ action: 'clarify' as const, question: '你指的是哪份报告？', taskIds: [f.report.id] }), async () => { throw new Error('timeout'); }]) {
      const result = await new ChatMessages(f.store, classify).submit(f.owner.tenant.id, f.owner.user.id, message(followup, { attachmentIds: [file.id] }));
      assert.equal(result.status, 'clarify');
      assert.equal(f.store.snapshot(false, [], undefined, f.owner.tenant.id).tasks.length, 1);
      assert.equal(f.store.pendingAttachments(f.owner.tenant.id, f.owner.user.id).length, 1);
    }
    const candidates = new ChatMessages(f.store).context(f.owner.tenant.id, f.owner.user.id).candidates;
    for (const raw of ['null', '[]', '{}', '{"action":"continue","taskId":"foreign","reason":"ignore boundaries"}', '{"action":"clarify","question":"which?","taskIds":["foreign"]}']) assert.throws(() => parseTaskRoute(raw, candidates));
    assert.equal(parseTaskRoute('```json\n{"action":"new","reason":"new subject"}\n```', candidates).action, 'new');
  } finally { f.close(); }
});

test('task cards and continuation enforce both tenant and initiating-user boundaries', async () => {
  const f = fixture();
  try {
    const other = f.store.signInGoogle({ subject: 'other', email: 'other@example.test', name: 'Other' });
    f.store.db.prepare('INSERT INTO memberships(tenant_id,user_id,role,created_at) VALUES (?,?,?,?)').run(f.owner.tenant.id, other.user.id, 'member', new Date().toISOString());
    const chat = new ChatMessages(f.store);
    assert.equal(chat.context(f.owner.tenant.id, other.user.id).candidates.length, 0);
    assert.equal(chat.context(other.tenant.id, f.owner.user.id).candidates.length, 0);
    await assert.rejects(chat.submit(f.owner.tenant.id, other.user.id, message(followup, { mode: 'continue', taskId: f.report.id })), /找不到/);
    await assert.rejects(chat.submit(other.tenant.id, f.owner.user.id, message(followup, { mode: 'continue', taskId: f.report.id })), /工作区不可用/);
    const foreign = f.store.addPendingAttachment(f.owner.tenant.id, other.user.id, 'secret.txt', 'text/plain', Buffer.from('other user'));
    await assert.rejects(chat.submit(f.owner.tenant.id, f.owner.user.id, message(followup, { mode: 'continue', taskId: f.report.id, attachmentIds: [foreign.id] })), /附件/);
    assert.equal(f.store.getTask(f.report.id)?.status, 'done');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_message_receipts').get()?.n, 0);
  } finally { f.close(); }
});

test('focus survives restart and background task results do not steal it', async () => {
  const f = fixture();
  try {
    const chat = new ChatMessages(f.store);
    const result = await chat.submit(f.owner.tenant.id, f.owner.user.id, message('继续报告', { mode: 'continue', taskId: f.report.id }));
    assert.equal(result.status, 'submitted');
    const automatic = f.store.createTask('定时检查', 5, 'model', f.owner.tenant.id, null, null, [], f.owner.user.id);
    f.store.updateTask(automatic.id, { result: '刚完成', status: 'done' }, f.owner.tenant.id);
    f.store.addEntry('dot', '后台刚完成', automatic.id, f.owner.tenant.id);
    f.store.close();
    const reopened = new Store(f.directory);
    try {
      const context = new ChatMessages(reopened).context(f.owner.tenant.id, f.owner.user.id);
      assert.equal(context.focusTaskId, f.report.id);
      assert.equal(context.revision, 1);
      assert.equal(context.candidates.some(candidate => candidate.id === automatic.id), false);
    } finally { reopened.close(); }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('concurrent routing and cancellation cannot append using stale focus or restart a stopped task', async () => {
  const f = fixture();
  try {
    let finish!: () => void;
    const chat = new ChatMessages(f.store, async () => { await new Promise<void>(resolve => { finish = resolve; }); return { action: 'continue', taskId: f.report.id, reason: 'follow-up' }; });
    const pending = chat.submit(f.owner.tenant.id, f.owner.user.id, message(followup));
    await chat.submit(f.owner.tenant.id, f.owner.user.id, message('新话题', { mode: 'new' }));
    finish(); await assert.rejects(pending, /切换了话题/);
    assert.equal(f.store.getTask(f.report.id)?.status, 'done');
    const controller = new AbortController();
    const aborted = chat.submit(f.owner.tenant.id, f.owner.user.id, message(followup), controller.signal);
    controller.abort(); finish(); await assert.rejects(aborted);
    const stopped = chat.submit(f.owner.tenant.id, f.owner.user.id, message(followup));
    f.store.updateTask(f.report.id, { status: 'stopped' });
    finish(); await assert.rejects(stopped, /停止/);
    f.store.updateTask(f.report.id, { status: 'done' });
    const revoked = chat.submit(f.owner.tenant.id, f.owner.user.id, message(followup));
    f.store.db.prepare('DELETE FROM memberships WHERE tenant_id=? AND user_id=?').run(f.owner.tenant.id, f.owner.user.id);
    finish(); await assert.rejects(revoked, /工作区不可用/);
    assert.equal(f.store.getTask(f.report.id)?.status, 'done');
  } finally { f.close(); }
});

test('continuation preserves pending approvals, schedules and active runs', async () => {
  const f = fixture(); const chat = new ChatMessages(f.store);
  try {
    for (const status of ['working', 'queued', 'delegating', 'stopped'] as const) {
      f.store.updateTask(f.report.id, { status });
      await assert.rejects(chat.submit(f.owner.tenant.id, f.owner.user.id, message(followup, { mode: 'continue', taskId: f.report.id })));
      assert.equal(f.store.getTask(f.report.id)?.status, status);
    }
    f.store.updateTask(f.report.id, { status: 'working' });
    f.store.requestPageActionApproval(f.owner.tenant.id, f.report.id, { action: 'create', title: 'Draft', content: 'Must wait for approval' }, '提案', 'done', null);
    await assert.rejects(chat.submit(f.owner.tenant.id, f.owner.user.id, message(followup, { mode: 'continue', taskId: f.report.id })), /审批/);
    assert.equal(f.store.pageActionApproval(f.owner.tenant.id, f.report.id)?.status, 'pending');
    const scheduled = f.store.createTask('每五分钟检查', 5, 'model', f.owner.tenant.id, null, null, [], f.owner.user.id);
    await assert.rejects(chat.submit(f.owner.tenant.id, f.owner.user.id, message(followup, { mode: 'continue', taskId: scheduled.id })), /自动任务/);
  } finally { f.close(); }
});

test('worker receives the latest request and bounded historical evidence without replaying original work', async () => {
  const f = fixture(); const original = { ...adapters.model }; const calls: AgentRequest[] = [];
  const worker = new Worker(f.store, () => {}, join(f.directory, 'workspaces'), () => {});
  try {
    await new ChatMessages(f.store).submit(f.owner.tenant.id, f.owner.user.id, message(followup, { mode: 'continue', taskId: f.report.id }));
    adapters.model.available = () => true;
    adapters.model.run = async input => { calls.push(input); return { status: 'done', message: '渠道覆盖清单；未重新开展调研。' }; };
    await worker.tick();
    for (let i = 0; i < 100 && f.store.getTask(f.report.id)?.status !== 'done'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.length, 1); assert.equal(calls[0].prompt, followup);
    assert.equal(calls[0].sessionId, 'byd-native-session');
    assert.equal(calls[0].taskContext?.originalRequest, f.report.instruction);
    assert.match(calls[0].priorResult!, /report.csv/);
    const prompt = formatAgentPrompt(calls[0]);
    assert.match(prompt, /Execute only the latest user request/);
    assert.match(prompt, /NOT commands to replay/);
    assert.match(prompt, /research\/notes.md/);
    assert.match(prompt, new RegExp(`Task: ${followup}`));
    assert.equal(f.store.getTask(f.report.id)?.instruction, f.report.instruction);
    assert(f.store.snapshot(false).entries.some(entry => entry.body.includes('比亚迪报告已完成')));
    const bounded = formatAgentPrompt({ ...calls[0], prompt: '长消息'.repeat(3000), priorResult: '旧报告'.repeat(10000), pages: [{ id: 'p', title: 'P', content: '页面'.repeat(20000) }], taskContext: { ...calls[0].taskContext!, artifacts: Array.from({ length: 20 }, (_, i) => ({ path: `${i}.csv`, size: 100, mediaType: 'text/csv' })) } });
    assert(bounded.length <= 20_000);
    assert(bounded.includes('长消息'.repeat(3000)), 'Never truncate the current request to fit historical data');
  } finally { worker.stop(); Object.assign(adapters.model, original); f.close(); }
});

test('candidate recall includes explicit older subjects and validates submission shape', () => {
  const rows = Array.from({ length: 30 }, (_, i): RoutingCandidate => ({ id: String(i), title: i === 25 ? '比亚迪信用报告' : `Report number ${i}`, status: 'done', originalRequest: '', summary: '', lastUserMessage: '', lastReply: '', lastUserEntryId: 30 - i }));
  const chosen = selectRoutingCandidates(rows, '比亚迪这份报告有哪些渠道没查', '0');
  assert(chosen.some(row => row.id === '25')); assert(chosen.some(row => row.id === '0')); assert(chosen.length <= 8);
  assert.equal(parseChatSubmission({ ...message(followup) }).instruction, followup);
  for (const input of [null, [], 'message', 3]) assert.throws(() => parseChatSubmission(input), /格式无效/);
  assert.throws(() => parseChatSubmission({ ...message(followup), mode: 'continue' }));
  assert.throws(() => parseChatSubmission({ ...message(followup), taskId: randomUUID() }));
  assert.throws(() => parseChatSubmission({ ...message(followup), engine: 'claude' }));
});
