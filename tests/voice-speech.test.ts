import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareVoiceSpeech } from '../src/server/voice-speech.ts';
import { VOICE_SUMMARY_FALLBACK } from '../src/shared/voice-speech.ts';

const config = { baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'deepseek-v4.1-flash', apiKey: 'test-secret' };

test('short Dot results are spoken without another model call', async () => {
  assert.deepEqual(await prepareVoiceSpeech('  已完成，共找到 17 条记录。  ', config, async () => { throw new Error('Unexpected model request'); }),
    { text: '已完成，共找到 17 条记录。', summarized: false });
});

test('voice summaries receive the complete result including conclusions beyond the old truncation point', async () => {
  const source = '逐条核验的记录。'.repeat(180) + '\n最终结论：17 条已核实，3 条仍待确认。';
  let received = '';
  const summary = '17 条记录已核实，3 条仍待确认。完整内容见聊天。';
  const result = await prepareVoiceSpeech(source, config, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    received = JSON.parse(body.messages[1].content).result;
    assert.equal(body.enable_thinking, false);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-secret');
    return Response.json({ choices: [{ message: { content: summary }, finish_reason: 'stop' }] });
  });
  assert.equal(received, source);
  assert.deepEqual(result, { text: summary, summarized: true });
  assert(source.endsWith('3 条仍待确认。'), 'Preparing speech must not overwrite the full chat result');
});

test('failed, empty, overlong or truncated summaries direct the user to the full result without reading fragments', async () => {
  const text = '完整任务结果。'.repeat(200);
  for (const response of [
    new Response('test-secret upstream error', { status: 503 }),
    Response.json({ choices: [] }),
    Response.json({ choices: [{ message: { content: '尚未读完的结论' }, finish_reason: 'length' }] }),
    Response.json({ choices: [{ message: { content: '冗长'.repeat(300) }, finish_reason: 'stop' }] }),
  ]) assert.deepEqual(await prepareVoiceSpeech(text, config, async () => response), { text: VOICE_SUMMARY_FALLBACK, summarized: false });
  assert.deepEqual(await prepareVoiceSpeech(text, null), { text: VOICE_SUMMARY_FALLBACK, summarized: false });
});

test('ending a call aborts summary preparation instead of returning speech to a closed call', async () => {
  const controller = new AbortController();
  const pending = prepareVoiceSpeech('任务结果。'.repeat(200), config, async (_url, init) => {
    controller.abort();
    assert(init?.signal?.aborted);
    throw new Error('upstream request cancelled');
  }, controller.signal);
  await assert.rejects(pending, /摘要已取消/);
});
