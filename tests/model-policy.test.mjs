import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { streamSimple } from '@mariozechner/pi-ai';
import { modelProfile, boundedToolContext } from '../deploy/linux-desktop/model-policy.mjs';

test('real Pi transport sends provider thinking off/on and preserves generic gateway compatibility', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const model = { ...modelProfile({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'deepseek-v4-1-flash-260910' }), baseUrl, api: 'openai-completions', provider: 'coke-dots-shared' };
    for (const reasoning of ['off', 'high', 'off']) {
      const result = await streamSimple(model, { messages: [{ role: 'user', content: 'Return ok', timestamp: Date.now() }] }, { apiKey: 'fixture', reasoning }).result();
      assert.equal(result.stopReason, 'stop', result.errorMessage);
    }
    assert.deepEqual(requests.map(r => r.thinking), [{ type: 'disabled' }, { type: 'enabled' }, { type: 'disabled' }]);
    assert.equal(requests[0].reasoning_effort, undefined);
    assert.equal(requests[1].reasoning_effort, 'high');
    const generic = { ...modelProfile({ baseUrl: 'https://example.test/v1', model: 'custom' }), baseUrl, api: 'openai-completions', provider: 'coke-dots-shared' };
    await streamSimple(generic, { messages: [{ role: 'user', content: 'ok', timestamp: Date.now() }] }, { apiKey: 'fixture', reasoning: 'off' }).result();
    assert.equal(requests[3].thinking, undefined, 'Unknown gateways do not receive DeepSeek fields');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('context reduction keeps recent evidence and tool pairing without mutating the complete journal', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({ role: 'toolResult', toolCallId: `call-${i}`, toolName: 'browser_execute', content: [{ type: 'text', text: String(i).repeat(i < 6 ? 20_000 : 6000) }, { type: 'image', data: 'screenshot', mimeType: 'image/png' }], isError: false, timestamp: i }));
  const before = structuredClone(messages);
  const reduced = boundedToolContext(messages, '/workspace/tasks/id/session.jsonl');
  assert.deepEqual(messages, before);
  assert.deepEqual(reduced.slice(-4), messages.slice(-4));
  assert.deepEqual(reduced.map(m => m.toolCallId), messages.map(m => m.toolCallId));
  assert(reduced[0].content[0].text.length < 2300);
  assert.match(reduced[0].content[0].text, /session.jsonl/);
  assert.equal(reduced[0].content[1].type, 'text');
});
