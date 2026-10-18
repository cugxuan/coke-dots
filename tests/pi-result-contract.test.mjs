import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as realSdk from '@mariozechner/pi-coding-agent';
import { runCloudKernel } from '../deploy/linux-desktop/cloud-kernel-adapter.mjs';

const exactReply = 'V4-Flash 配置验证成功。';
const decision = (message = exactReply, status = 'done', extra = {}) => JSON.stringify({ status, message, ...extra });
const bash = command => [{ index: 0, id: 'call-1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }];

async function fixture(replies, verify, options = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dots-result-contract-'));
  const taskId = '11111111-1111-4111-8111-111111111111';
  const cwd = path.join(workspace, 'tasks', taskId);
  await mkdir(cwd, { recursive: true });
  const requests = []; const events = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString()); requests.push(payload);
    const reply = replies[requests.length - 1];
    if (!reply) { res.writeHead(400); res.end('Unexpected extra request'); return; }
    if (reply.onRequest) reply.onRequest();
    if (reply.httpStatus) { res.writeHead(reply.httpStatus); res.end(JSON.stringify({ error: { message: 'fixture provider failure' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant', ...(reply.tools ? { tool_calls: reply.tools } : { content: reply.text ?? '' }) });
    emit({}, reply.finish || (reply.tools ? 'tool_calls' : 'stop'));
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sdk = { ...realSdk, ModelRegistry: { inMemory(auth) {
    const registry = realSdk.ModelRegistry.inMemory(auth);
    const register = registry.registerProvider.bind(registry);
    registry.registerProvider = (name, config) => register(name, { ...config, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    return registry;
  } } };
  const run = overrides => runCloudKernel({ engine: 'pi', taskId, cwd, workspace,
    prompt: `不要使用工具，不要创建或修改文件。请只回复：${exactReply}`,
    modelConfig: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'deepseek-v4-flash-ga-260731', apiKey: 'fixture-only' },
    onProgress: event => events.push(event), ...options, ...overrides }, { piSdk: sdk });
  try { await verify({ run, requests, events, cwd }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(workspace, { recursive: true, force: true }); }
}

test('Pi sends the app result contract as a system instruction and accepts a valid exact reply in one call', async () => {
  await fixture([{ text: decision() }], async ({ run, requests }) => {
    assert.equal((await run()).message, exactReply);
    assert.equal(requests.length, 1);
    assert(requests[0].messages.some(message => message.role === 'system' && message.content.includes('Coke Dots task result protocol')));
    assert(requests[0].messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('请只回复')));
  });
});

test('Pi recovers a plain-text final answer once, with tools absent and both calls included in usage and timings', async () => {
  await fixture([{ text: exactReply }, { text: decision() }], async ({ run, requests, events }) => {
    const result = await run();
    assert.equal(result.status, 'done'); assert.equal(result.message, exactReply);
    assert.equal(requests.length, 2);
    assert(!requests[1].tools?.length);
    assert.equal(events.filter(event => event.kind === 'usage').at(-1).usage.total, 240);
    assert.equal(events.filter(event => event.kind === 'metrics').at(-1).timing.modelCalls, 2);
    assert.equal(events.filter(event => event.kind === 'metrics').at(-1).timing.toolCalls, 0);
  });
});

test('Pi format recovery preserves waiting, schedules and optional decisions instead of converting all prose to done', async t => {
  for (const [text, result] of [
    ['请提供目标地址，我还没有执行操作。', { status: 'waiting', message: '请提供目标地址，我还没有执行操作。' }],
    ['{"status":"scheduled","message":"按要求继续检查","nextMinutes":15', { status: 'scheduled', message: '按要求继续检查', nextMinutes: 15 }],
    ['```json\n{"status":"delegating","message":"分工处理","delegations":[{"title":"核查","instruction":"读取页面"}]}\n``` trailing {}', { status: 'delegating', message: '分工处理', delegations: [{ title: '核查', instruction: '读取页面' }] }],
    ['{"status":"done","message":"保存笔记","memoryAction":{"action":"save","note":"工作偏好"},"pageAction":{"action":"create","title":"核查","content":"记录"}} trailing {}', { status: 'done', message: '保存笔记', memoryAction: { action: 'save', note: '工作偏好' }, pageAction: { action: 'create', title: '核查', content: '记录' } }],
  ]) await t.test(result.status, async () => fixture([{ text }, { text: JSON.stringify(result) }], async ({ run, requests }) => {
    const { sessionId, ...value } = await run(); assert.deepEqual(value, result);
    assert.equal(requests.length, 2); assert(!requests[1].tools?.length);
  }));
});

test('Pi formats after a real Bash side effect without replaying it and resumes the same native session', async () => {
  await fixture([{ tools: bash("printf 'once\\n' >> performed.txt") }, { text: '已完成。' }, { text: decision('已完成。') }, { text: decision('继续完成。') }], async ({ run, requests, cwd }) => {
    const first = await run({ prompt: 'Append once to performed.txt, then report completion.' });
    assert.equal(requests.length, 3); assert(!requests[2].tools?.length);
    assert.equal(await readFile(path.join(cwd, 'performed.txt'), 'utf8'), 'once\n');
    const second = await run({ sessionId: first.sessionId, prompt: 'Do not use tools. Reply: 继续完成。' });
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(requests.length, 4);
    assert.equal(await readFile(path.join(cwd, 'performed.txt'), 'utf8'), 'once\n');
    const dir = path.join(cwd, '.coke-dots-agent-runtime/pi-sessions');
    const files = await readdir(dir); assert.equal(files.length, 1);
    const journal = (await readFile(path.join(dir, files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(journal.filter(row => row.message?.role === 'toolResult' && row.message.toolName === 'bash').length, 1);
    assert(journal.some(row => row.message?.role === 'assistant' && row.message.content.some(item => item.text === '已完成。')));
  });
});

test('Pi rejects a second malformed answer without an unbounded format loop', async () => {
  await fixture([{ text: '普通回复' }, { text: '还是普通回复' }], async ({ run, requests }) => {
    await assert.rejects(run(), /任务结果格式整理失败/); assert.equal(requests.length, 2);
  });
});

test('Pi never executes a tool hallucinated by the formatting response', async () => {
  await fixture([{ text: '普通回复' }, { tools: bash('touch forbidden.txt') }], async ({ run, requests, cwd }) => {
    await assert.rejects(run(), /格式整理尝试调用工具/);
    assert.equal(requests.length, 2);
    await assert.rejects(readFile(path.join(cwd, 'forbidden.txt')), { code: 'ENOENT' });
  });
});

test('Pi preserves provider failures, truncation and empty replies instead of converting them to success', async t => {
  for (const [reply, error] of [[{ httpStatus: 401 }, /模型请求失败/], [{ text: 'partial', finish: 'length' }, /输出上限/], [{ text: '' }, /no assistant text/]]) {
    await t.test(String(reply.httpStatus || reply.finish || 'empty'), async () => fixture([reply], async ({ run, requests }) => {
      await assert.rejects(run(), error); assert.equal(requests.length, 1);
    }));
  }
});

test('Pi does not retry a failed formatting provider request', async () => {
  await fixture([{ text: '普通回复' }, { httpStatus: 503 }], async ({ run, requests }) => {
    await assert.rejects(run(), /模型请求失败/); assert.equal(requests.length, 2);
  });
});

test('Pi respects cancellation during the formatting pass', async () => {
  const controller = new AbortController();
  await fixture([{ text: '普通回复' }, { text: decision(), onRequest: () => controller.abort(new Error('fixture user takeover')) }], async ({ run, requests }) => {
    await assert.rejects(run(), /fixture user takeover/); assert.equal(requests.length, 2);
  }, { signal: controller.signal });
});
