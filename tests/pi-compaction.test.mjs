import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as realSdk from '@mariozechner/pi-coding-agent';
import { runCloudKernel } from '../deploy/linux-desktop/cloud-kernel-adapter.mjs';

test('real Pi compacts inside a tool loop before the final response, retains evidence and accounts for summaries', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dots-compaction-'));
  const taskId = '11111111-1111-4111-8111-111111111111';
  const cwd = path.join(root, 'tasks', taskId);
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, 'evidence.txt'), Array.from({ length: 400 }, (_, i) => `evidence-line-${i}: ${'verified source '.repeat(5)}`).join('\n'));
  const requests = []; const events = []; const transports = [];
  let normal = 0; let summaries = 0; let expectedTotal = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString()); requests.push(payload);
    const summary = !payload.tools?.length;
    if (summary) summaries++; else normal++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!summary && normal <= 3) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: `read-${normal}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'evidence.txt' }) } }] });
      emit({}, 'tool_calls');
    } else {
      emit({ role: 'assistant', content: summary ? 'Completed three reads of evidence.txt. The verified source is retained in evidence.txt and the original session journal. Final result: fixture facts preserved.' : JSON.stringify({ status: 'done', message: 'fixture facts preserved' }) });
      emit({}, 'stop');
    }
    const input = summary ? 200 : normal === 3 ? 32_000 : 1000;
    expectedTotal += input + 20;
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Keep the production profile and transport; redirect only its endpoint to the fixture.
  const sdk = { ...realSdk, ModelRegistry: { inMemory(auth) {
    const registry = realSdk.ModelRegistry.inMemory(auth);
    const register = registry.registerProvider.bind(registry);
    registry.registerProvider = (name, config) => register(name, { ...config, streamSimple: (...args) => { transports.push({summary: !args[1].tools?.length}); return config.streamSimple(...args); }, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    return registry;
  } } };
  try {
    const result = await runCloudKernel({ engine: 'pi', taskId, cwd, workspace: root, prompt: 'Read the evidence and return the requested JSON decision.', modelConfig: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'deepseek-v4-1-flash-260910', apiKey: 'fixture-only' }, onProgress: event => events.push(event) }, { piSdk: sdk });
    assert.equal(result.status, 'done');
    assert.equal(result.message, 'fixture facts preserved');
    assert.equal(normal, 4); assert(summaries >= 1);
    assert(!requests[3].tools?.length, 'compaction must happen before asking for the final answer');
    assert.match(requests[3].messages.find(m => m.role === 'system').content, /^You are a context summarization assistant\./);
    const summaryPrompt = JSON.stringify(requests[3].messages.find(m => m.role === 'user').content);
    assert.match(summaryPrompt, /The messages above are a conversation to summarize/);
    assert.match(summaryPrompt, /Use this EXACT format:/);
    assert.match(summaryPrompt, /用中文整理上下文/);
    assert(requests.at(-1).tools?.length, 'no compaction request after the final answer');
    assert.match(JSON.stringify(requests.at(-1).messages), /Completed three reads/);
    assert(requests.every(request => request.max_tokens <= 8192));
    assert(requests.every(request => request.thinking?.type === 'disabled'));
    assert.equal(events.filter(event => event.kind === 'usage').at(-1).usage.total, expectedTotal, 'Summary requests must be included in reported usage');
    assert.equal(transports.length, requests.length);
    assert.equal(events.filter(event => event.kind === 'metrics').at(-1).timing.compactions, 1);
    assert.equal(events.filter(event => event.kind === 'metrics').at(-1).timing.modelCalls, requests.length);
    const directory = path.join(cwd, '.coke-dots-agent-runtime/pi-sessions');
    const file = (await readdir(directory)).find(name => name.endsWith('.jsonl'));
    const journal = (await readFile(path.join(directory, file), 'utf8')).trim().split('\n').map(JSON.parse);
    assert(journal.some(entry => entry.type === 'compaction'));
    assert(journal.some(entry => entry.message?.role === 'toolResult' && JSON.stringify(entry.message).includes('evidence-line-399')));
    assert((await readFile(path.join(cwd, 'evidence.txt'), 'utf8')).includes('evidence-line-399'));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
