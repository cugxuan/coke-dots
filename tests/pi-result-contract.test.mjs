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
    res.write(`data: ${JSON.stringify({ choices: [], usage: reply.usage || { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
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

test('Pi retains the completed answer when overflow compaction temporarily removes it from active context', async () => {
  await fixture([
    { tools: bash("printf 'saved once\\n' >> completed.txt; printf 'evidence %.0s' {1..16000}") },
    { text: decision('已保存 completed.txt。'), usage: { prompt_tokens: 42725, completion_tokens: 665, total_tokens: 43390 } },
    { text: 'The task is complete. completed.txt was written once; no further work remains.' },
  ], async ({ run, requests, events, cwd }) => {
    const result = await run({ prompt: 'Save evidence once and report completion.' });
    assert.equal(result.status, 'done');
    assert.equal(result.message, '已保存 completed.txt。');
    // Pi schedules an overflow continuation after compaction; it must not replay work.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(requests.length, 3, 'one tool request, final answer, and compaction only');
    assert.equal(await readFile(path.join(cwd, 'completed.txt'), 'utf8'), 'saved once\n');
    assert.equal(events.filter(event => event.kind === 'metrics').at(-1).timing.compactions, 1);
    const directory = path.join(cwd, '.coke-dots-agent-runtime/pi-sessions');
    const [file] = await readdir(directory);
    const journal = (await readFile(path.join(directory, file), 'utf8')).trim().split('\n').map(JSON.parse);
    assert(journal.some(row => row.type === 'compaction'), 'the real SDK persisted a compaction');
    assert.equal(journal.filter(row => row.message?.role === 'toolResult').length, 1);
  });
});

test('Pi repairs captured final JSON missing its closing brace after compaction without replaying tools', async () => {
  await fixture([
    { tools: bash("printf 'saved once\\n' >> completed.txt; printf 'evidence %.0s' {1..16000}") },
    { text: decision('已保存结果；来源 B 需要登录。', 'waiting').slice(0, -1), usage: { prompt_tokens: 42725, completion_tokens: 20, total_tokens: 42745 } },
    { text: 'Evidence was saved. Source B requires login. Do not repeat the write.' },
    { text: decision('已保存结果；来源 B 需要登录。', 'waiting') },
  ], async ({ run, requests, cwd }) => {
    const result = await run({ prompt: 'Save evidence once and report any blockers.' });
    assert.equal(result.status, 'waiting');
    assert.equal(result.message, '已保存结果；来源 B 需要登录。');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(requests.length, 4);
    assert(!requests[3].tools?.length);
    assert.match(JSON.stringify(requests[3].messages.at(-1)), /已保存结果；来源 B 需要登录/);
    assert.equal(await readFile(path.join(cwd, 'completed.txt'), 'utf8'), 'saved once\n');
  });
});

test('Pi still rejects an empty final answer after compaction instead of using an older tool turn', async () => {
  await fixture([
    { tools: bash("printf 'evidence %.0s' {1..16000}") },
    { text: '', usage: { prompt_tokens: 42725, completion_tokens: 0, total_tokens: 42725 } },
    { text: 'The tool returned evidence but there was no final answer.' },
  ], async ({ run, requests }) => {
    await assert.rejects(run({ prompt: 'Inspect fixture evidence.' }), /Pi returned no assistant text/);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(requests.length, 3);
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

test('Pi accepts mixed instruction/description delegation fields in one call before crossing the cloud boundary', async () => {
  const delegations = [{ title: 'Source A', instruction: 'Analyze supplied A.' }, { title: 'Source B', description: 'Analyze supplied B.' }, { title: 'Source C', description: 'Analyze supplied C.' }];
  await fixture([{ text: decision('分工核查', 'delegating', { delegations }) }], async ({ run, requests }) => {
    const result = await run();
    assert.equal(requests.length, 1);
    assert.deepEqual(result.delegations.map(child => child.instruction), ['Analyze supplied A.', 'Analyze supplied B.', 'Analyze supplied C.']);
    assert(result.delegations.every(child => !('description' in child)));
  });
});

test('Pi repairs invalid child content in the same session without replaying tools or losing valid siblings', async () => {
  const children = [{ title: 'Source A', instruction: 'Analyze A.' }, { title: 'B'.repeat(121), instruction: 'Analyze B.' }];
  await fixture([
    { tools: bash("printf 'saved evidence\\n' >> partial.txt") },
    { text: decision('分工核查', 'delegating', { delegations: children }) },
    { text: decision('分工核查', 'delegating', { delegations: [children[0], { ...children[1], title: 'Source B' }] }) },
  ], async ({ run, requests, cwd }) => {
    const result = await run({ prompt: 'Save evidence once, then delegate analysis of sources A and B.' });
    assert.equal(requests.length, 3);
    assert(!requests[2].tools?.length);
    assert.match(JSON.stringify(requests[2].messages.at(-1)), /第 2 项需要 title/);
    assert.deepEqual(result.delegations.map(child => child.instruction), ['Analyze A.', 'Analyze B.']);
    assert.equal(await readFile(path.join(cwd, 'partial.txt'), 'utf8'), 'saved evidence\n');
  });
});

test('Pi stops after one unsuccessful delegation repair instead of an unbounded retry loop', async () => {
  const invalid = decision('分工核查', 'delegating', { delegations: [null] });
  await fixture([{ text: invalid }, { text: invalid }], async ({ run, requests }) => {
    await assert.rejects(run(), /任务结果格式整理失败/);
    assert.equal(requests.length, 2);
  });
});

test('Pi continues after a failed source tool and retains a real CSV from the successful source', async () => {
  await fixture([
    { tools: bash("printf 'Source A unavailable: HTTP 503\\n' >&2; exit 1") },
    { tools: bash("printf 'source,finding\\nB,verified fixture evidence\\n' > findings.csv") },
    { text: decision('已保存 B 的核实结果到 findings.csv；A 返回 HTTP 503，需人工补查，未检出不等于无风险。') },
  ], async ({ run, requests, cwd }) => {
    const result = await run({ prompt: 'Query independent fixture sources A and B; preserve successful evidence and report unavailable sources.' });
    assert.equal(result.status, 'done');
    assert.match(result.message, /A 返回 HTTP 503/);
    assert.equal(requests.length, 3);
    assert.match(JSON.stringify(requests[1].messages), /Source A unavailable/);
    assert.equal(await readFile(path.join(cwd, 'findings.csv'), 'utf8'), 'source,finding\nB,verified fixture evidence\n');
  });
});
