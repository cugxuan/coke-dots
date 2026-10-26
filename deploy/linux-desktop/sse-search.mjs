// Public SSE search metadata only. Documents still need separate verification.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const endpoint = 'https://query.sse.com.cn/search/getESSearchDoc.do?jsonCallBack=cokeDotsSearch';
const referer = 'https://www.sse.com.cn/home/search/';
const clean = value => String(value ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

export async function searchSse({ keyword, page = 0, limit = 10, mode = 'precise', sort = 'score' }, { fetchImpl = fetch, signal } = {}) {
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 200 || /[\u0000-\u001f\u007f]/.test(keyword)) throw new Error('keyword must contain 1–200 characters');
  if (!Number.isInteger(page) || page < 0 || page > 499) throw new Error('page must be an integer from 0 to 499');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50');
  if (!['precise', 'preciseMulti', 'fuzzy'].includes(mode) || !['score', 'create_time'].includes(sort)) throw new Error('Unsupported search mode or sort');
  const body = new URLSearchParams({
    keyword: keyword.trim(), keywordPosition: 'title,paper_content', siteName: 'sse',
    page: String(page), limit: String(limit), channelId: '10001', spaceId: '3', searchMode: mode, orderByKey: sort,
  });
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetchImpl(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer, 'user-agent': 'Mozilla/5.0' },
    body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`SSE search HTTP ${response.status}; inspect the source before another route`);
  const raw = await response.text();
  const match = raw.trim().match(/^cokeDotsSearch\(([\s\S]*)\)\s*;?$/);
  let value;
  try { value = JSON.parse(match ? match[1] : raw); } catch { throw new Error('SSE search returned invalid JSON/JSONP'); }
  if (String(value?.code) !== '0' || !Array.isArray(value?.data?.knowledgeList)) throw new Error('SSE search rejected the query; do not treat HTTP 200 as success');
  const seen = new Set();
  const rows = [];
  for (const item of value.data.knowledgeList.slice(0, limit)) {
    const fields = Object.fromEntries((Array.isArray(item.extend) ? item.extend : []).filter(e => typeof e?.name === 'string').map(e => [e.name, e.value]));
    let url;
    try {
      const parsed = new URL(fields.CURL || item.url, 'https://www.sse.com.cn/');
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !(fields.CURL || item.url)) throw new Error();
      url = parsed.href;
    } catch { throw new Error('SSE search result has no usable source URL'); }
    const title = clean(item.title);
    if (!title) throw new Error('SSE search result has no title');
    const key = `${url}\n${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ title, url, date: clean(item.createTime), issuer: clean(fields.GSJC), securityCode: clean(fields.ZQDM) });
  }
  return { source: referer, keyword: keyword.trim(), page, limit, totalReported: value.data.totalSize, received: Math.min(value.data.knowledgeList.length, limit),
    rows, note: '仅为搜索目录；totalReported 可能为上限，不代表已核验数量。逐项读取相关原文并保留 URL；没有命中不证明没有风险。' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { keyword: { type: 'string' }, page: { type: 'string' }, limit: { type: 'string' }, mode: { type: 'string' }, sort: { type: 'string' } } });
    const result = await searchSse({ ...values, page: values.page === undefined ? 0 : Number(values.page), limit: values.limit === undefined ? 10 : Number(values.limit) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
