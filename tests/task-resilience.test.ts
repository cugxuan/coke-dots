import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adapters, parseDecision, formatAgentPrompt, type AgentRequest } from '../src/server/adapters.ts';
import { Store } from '../src/server/store.ts';
import { Worker } from '../src/server/worker.ts';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 6_000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert(condition(), 'Worker did not reach the expected state');
}

test('parent synthesizes success, failure and blocked source once and persists incomplete coverage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dots-partial-research-'));
  const store = new Store(directory);
  const owner = store.signInGoogle({ subject: 'research-owner', email: 'owner@example.test', name: 'Owner' });
  const original = { ...adapters.model };
  const gates = new Map<string, () => void>();
  const calls: AgentRequest[] = [];
  const parent = store.createTask('Research independent sources A, B and C', null, 'model', owner.tenant.id);
  const worker = new Worker(store, () => {}, join(directory, 'workspaces'), () => {});
  adapters.model.available = () => true;
  adapters.model.run = async input => {
    calls.push(input);
    if (input.prompt === parent.instruction && !input.delegatedResults?.length) {
      return parseDecision(JSON.stringify({ status: 'delegating', message: '核查三个来源', delegations: [
        { title: 'Source A', instruction: 'Read source A' },
        { title: 'Source B', description: 'Read source B' },
        { title: 'Source C', description: 'Read source C' },
      ] }));
    }
    if (input.delegatedResults?.length) {
      assert.equal(input.allowDelegation, false);
      assert.deepEqual(input.delegatedResults.map(child => child.status), ['done', 'failed', 'waiting']);
      assert.match(input.delegatedResults[0].result || '', /verified evidence A/);
      assert.match(input.delegatedResults[1].error || '', /HTTP 503/);
      assert.match(input.delegatedResults[2].result || '', /CAPTCHA/);
      return { status: 'done', message: '已汇总 verified evidence A。' };
    }
    await new Promise<void>(resolve => gates.set(input.prompt, resolve));
    if (input.prompt === 'Read source B') throw new Error('Source B HTTP 503');
    if (input.prompt === 'Read source C') return { status: 'waiting', message: 'Source C requires CAPTCHA; query incomplete.' };
    return { status: 'done', message: 'verified evidence A' };
  };
  try {
    worker.start();
    await until(() => gates.size === 3);
    gates.get('Read source C')!();
    await until(() => store.delegatedTasks(parent.id, parent.tenantId)[2].status === 'waiting');
    assert.equal(store.getTask(parent.id, parent.tenantId)?.status, 'delegating', 'Running siblings must still finish');
    gates.get('Read source A')!();
    gates.get('Read source B')!();
    await until(() => ['done', 'failed'].includes(store.getTask(parent.id, parent.tenantId)?.status || ''));
    const finished = store.getTask(parent.id, parent.tenantId)!;
    assert.equal(finished.status, 'done');
    assert.equal(finished.error, null);
    assert.match(finished.result || '', /verified evidence A/);
    assert.match(finished.result || '', /Source B（执行失败）：Source B HTTP 503/);
    assert.match(finished.result || '', /Source C（待补查）：Source C requires CAPTCHA/);
    assert.equal(calls.length, 5, 'Only initial plan, three children and one aggregation are allowed');
    assert.equal(store.releaseReadyDelegations(), 0);
    const other = store.signInGoogle({ subject: 'other-reader', email: 'other@example.test', name: 'Other' });
    assert.equal(store.delegatedTasks(parent.id, other.tenant.id).length, 0);
    assert.equal(store.getTask(parent.id, other.tenant.id), null);
    const messages = store.snapshot(false, [], undefined, parent.tenantId).entries.filter(entry => entry.taskId === parent.id && entry.kind === 'dot');
    assert(messages.some(entry => entry.body === finished.result), 'The user-visible result must include the stored gap report');
  } finally {
    worker.stop();
    for (const release of gates.values()) release();
    await until(() => store.delegatedTasks(parent.id, parent.tenantId).every(child => child.status !== 'working'));
    Object.assign(adapters.model, original);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('partial aggregation does not resume a paused parent or bypass a paused child', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dots-partial-pause-'));
  const store = new Store(directory);
  try {
    const parent = store.createTask('Partial work');
    store.updateTask(parent.id, { status: 'working' });
    const [first, second] = store.createDelegatedTasks(parent.id, parent.tenantId, [
      { title: 'Known evidence', instruction: 'Analyze supplied evidence' },
      { title: 'Missing source', instruction: 'Read the other source' },
    ], 'Research');
    store.updateTask(first.id, { status: 'done', result: 'Evidence' });
    store.updateTask(second.id, { status: 'paused' });
    assert.equal(store.releaseReadyDelegations(), 0);
    store.updateTask(second.id, { status: 'waiting', result: 'Login required' });
    store.updateTask(parent.id, { status: 'paused' });
    assert.equal(store.releaseReadyDelegations(), 0);
    store.updateTask(parent.id, { status: 'delegating' });
    assert.equal(store.releaseReadyDelegations(), 1);
    assert.equal(store.getTask(second.id)?.status, 'waiting', 'No blocked source should be silently retried');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('research instructions distinguish engine capabilities and preserve source failures as evidence', () => {
  const prompt = formatAgentPrompt({ prompt: 'Research', priorResult: null, sessionId: null, workspace: '/task', onEvent: () => {}, allowDelegation: true, availableEngines: ['model', 'pi'], engine: 'pi', cloudComputerTask: true });
  assert.match(prompt, /model 没有实时网页、浏览器、shell 或文件写入工具/);
  assert.match(prompt, /不得把浏览器研究交给 model/);
  assert.match(prompt, /逐步保存已核实发现/);
  assert.match(prompt, /失败或未查询的来源、覆盖限制和人工跟进项/);
  assert.match(prompt, /不得绕过访问控制或用户取消/);
});
