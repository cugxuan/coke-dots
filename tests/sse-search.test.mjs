import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchSse } from '../deploy/linux-desktop/sse-search.mjs';

const item = (title = '<em>比亚迪</em>公告', url = '/disclosure/sample.pdf') => ({ title, createTime: '2026-10-26', extend: [
  { name: 'CURL', value: url }, { name: 'GSJC', value: '比亚迪' }, { name: 'ZQDM', value: '002594' },
] });
const payload = rows => ({ code: '0', data: { totalSize: 5000, knowledgeList: rows } });

test('SSE search sends the effective keyword field and returns usable source metadata', async () => {
  let calls = 0;
  const result = await searchSse({ keyword: '比亚迪 公司债券', page: 2, limit: 20 }, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(new URL(url).hostname, 'query.sse.com.cn');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('keywordPosition'), 'title,paper_content');
    assert.equal(options.body.get('siteName'), 'sse');
    assert.equal(options.body.get('page'), '2');
    assert.equal(options.body.get('limit'), '20');
    assert.equal(options.body.has('searchword'), false);
    // The upstream ignores searchword and otherwise returns unrelated records.
    const title = options.body.get('keyword') === '比亚迪 公司债券' ? '<em>比亚迪</em>公告' : '无关公司公告';
    return new Response(`cokeDotsSearch(${JSON.stringify(payload([item(title), item(title)]))});`);
  } });
  assert.equal(calls, 1);
  assert.equal(result.rows.length, 1, 'Duplicate documents must not inflate coverage');
  assert.deepEqual(result.rows[0], { title: '比亚迪公告', url: 'https://www.sse.com.cn/disclosure/sample.pdf', date: '2026-10-26', issuer: '比亚迪', securityCode: '002594' });
  assert.equal(result.received, 2);
  assert.match(result.note, /不代表已核验/);
});

test('SSE search distinguishes empty coverage, HTTP errors and business errors without retries', async t => {
  for (const [name, response, error] of [
    ['empty', () => new Response(JSON.stringify(payload([]))), null],
    ['http error', () => new Response('busy', { status: 503 }), /HTTP 503/],
    ['HTTP 200 business failure', () => new Response('({"success":"false","error":"系统繁忙"})'), /invalid JSON|rejected/],
    ['business failure JSON', () => new Response('{"code":"1","data":{}}'), /rejected/],
    ['invalid payload', () => new Response('<html>login</html>'), /invalid JSON/],
    ['missing URL', () => new Response(JSON.stringify(payload([{ title: '比亚迪' }]))), /source URL/],
    ['non-HTTP URL', () => new Response(JSON.stringify(payload([item('比亚迪', 'javascript:void(0)')]))), /source URL/],
  ]) await t.test(name, async () => {
    let calls = 0;
    const run = () => searchSse({ keyword: '比亚迪' }, { fetchImpl: async () => { calls++; return response(); } });
    if (error) await assert.rejects(run(), error);
    else assert.deepEqual((await run()).rows, []);
    assert.equal(calls, 1, 'Source errors must not trigger speculative retries');
  });
});

test('SSE search validates query bounds before networking and honors cancellation', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify(payload([]))); };
  for (const options of [{ keyword: '' }, { keyword: '比亚迪', limit: 51 }, { keyword: '比亚迪', page: -1 }, { keyword: '比亚迪', mode: 'guess' }]) {
    await assert.rejects(searchSse(options, { fetchImpl }));
  }
  assert.equal(calls, 0);
  const controller = new AbortController();
  controller.abort(new Error('Task cancelled'));
  await assert.rejects(searchSse({ keyword: '比亚迪' }, { signal: controller.signal, fetchImpl: async (_url, { signal }) => {
    signal.throwIfAborted();
  } }), /Task cancelled/);
});
