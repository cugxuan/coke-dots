import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { createBrowserExecutor } from '../../deploy/linux-desktop/browser-executor.mjs';

test('real Browser Use executor batches observed actions, keeps tabs/login, rejects stale ids and yields to takeover', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dots-browser-executor-'));
  const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
    headless: true, executablePath: process.env.DOTS_TEST_CHROME || chromium.executablePath(),
    args: ['--remote-debugging-port=0'],
  });
  const [port] = (await readFile(path.join(root, 'profile', 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const cdpUrl = `http://127.0.0.1:${port}`;
  let owner = 'agent';
  let executor;
  const browserTimings = [];
  const asyncHits = [];
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/v1/')) {
      assert.equal(req.headers.authorization, 'Bearer private-worker-token');
      const pages = await (await fetch(`${cdpUrl}/json/list`)).json();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ owner, targetId: pages.find(p => p.type === 'page').id }));
    } else if (req.url.startsWith('/async-data')) {
      const query = new URL(req.url, 'http://fixture').searchParams;
      asyncHits.push(query.get('kind'));
      await new Promise(resolve => setTimeout(resolve, Number(query.get('delay'))));
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ready');
    } else if (req.url.startsWith('/async')) {
      const delay = Number(new URL(req.url, 'http://fixture').searchParams.get('delay')) || 0;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>Async results</title><label>Query<input id="query"></label><button id="search" onclick="document.querySelector('#result').textContent='Loading';fetch('/async-data?delay=600&kind=click').then(r=>r.text()).then(()=>document.querySelector('#result').textContent='Result: '+document.querySelector('#query').value)">Search async</button><p id="result"></p><p id="status">Loading</p><script>fetch('/async-data?delay=${delay}&kind=navigate').then(r=>r.text()).then(()=>document.querySelector('#status').textContent='Navigation ready')</script>`);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Browser executor fixture</title><label>Search<input id="query"></label><button id="search" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#query\').value">Search now</button><p id="result"></p><a href="/next">Next</a>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const make = () => createBrowserExecutor({ computer: { baseUrl: origin, workerToken: 'private-worker-token' }, cwd: root, cdpUrl, secrets: ['private-worker-token'], onTiming: detail => browserTimings.push(detail) });
  const run = async code => {
    const result = await executor.tool.execute('fixture', { code });
    assert(result.content[0].text);
    return result;
  };
  try {
    await context.pages()[0].goto(origin);
    await context.addCookies([{ name: 'login_fixture', value: 'retained', url: origin }]);
    executor = make();
    await executor.warmUp();
    assert.equal(context.pages().length, 1, 'Warming the executor attaches the existing tab');
    await run('var s = await ui.state(); var input = s.controls.find(n => n.role === "textbox").id; var button = s.controls.find(n => n.name === "Search now").id;');
    const result = await run('await ui.fill(input, "batched search"); await ui.click(button);');
    assert.match(result.content[0].text, /batched search/);
    assert.equal(await context.pages()[0].locator('#result').textContent(), 'batched search');
    const textWait = await run('await ui.waitFor({text: "batched", timeoutMs: 750});');
    assert(textWait.details.pageWaitMs < 750, 'A visible substring must satisfy the wait');
    await assert.rejects(executor.tool.execute('missing-result', { code: 'await ui.waitFor({text: "not in this page", timeoutMs: 100});' }), /Timeout/);
    assert(browserTimings.at(-1).pageWaitMs >= 90, 'Failed waits must count toward page wait duration');
    assert(result.details.outputFile);
    assert.equal((await readFile(path.join(root, result.details.outputFile), 'utf8')).includes('private-worker-token'), false);
    await run(`await ui.goto(${JSON.stringify(`${origin}/next`)});`);
    await assert.rejects(executor.tool.execute('stale', { code: 'await ui.click(button);' }), /observed|Observe|inspect|Inspect/);
    await run(`await ui.open(${JSON.stringify(`${origin}/second`)}); await ui.open(${JSON.stringify(`${origin}/third`)});`);
    assert.equal(context.pages().length, 3);
    await executor.close();
    assert.equal(context.pages().length, 3, 'Ending a task must retain all browser tabs');
    assert.equal((await context.cookies(origin))[0].value, 'retained');
    executor = make();
    await run('var tabs = await ui.listTabs(); await ui.closeTabs(tabs.map(t => t.id));');
    assert.equal(context.pages().length, 1);
    assert.equal(context.pages()[0].url(), 'about:blank');
    assert.equal(context.browser().isConnected(), true, 'Close-all must not exit Chromium');
    const waiting = executor.tool.execute('takeover', { code: 'await new Promise(resolve => setTimeout(resolve, 15000)); await ui.open("https://example.invalid");', waitReason: 'Fixture explicitly requests a timed observation to verify cancellation.' });
    const began = Date.now();
    const handoff = setTimeout(() => { owner = 'user'; }, 400);
    await assert.rejects(waiting, /controls|cancel|abort|execution/i);
    clearTimeout(handoff);
    assert(Date.now() - began < 4000);
    assert.equal(context.pages().length, 1, 'A cancelled cell must not continue browser actions');
    await assert.rejects(executor.tool.execute('blocked', { code: 'await ui.open("https://example.invalid")' }), /controls/);
    owner = 'agent';
    await run(`await ui.goto(${JSON.stringify(origin)});`);
    assert.equal((await context.cookies(origin))[0].value, 'retained');
    const fast = performance.now();
    await run(`await ui.goto(${JSON.stringify(`${origin}/async?delay=0`)}, {waitFor: {text: 'Navigation ready', timeoutMs: 2000}});`);
    assert(performance.now() - fast < 2000, 'Ready pages must not pay a fixed multi-second delay');
    await run(`await ui.goto(${JSON.stringify(`${origin}/async?delay=600`)}, {waitFor: {text: 'Navigation ready', timeoutMs: 2000}}); var s=await ui.state(); var asyncInput=s.controls.find(n=>n.role==='textbox').id; var asyncButton=s.controls.find(n=>n.name==='Search async').id;`);
    assert.equal(await context.pages()[0].locator('#status').textContent(), 'Navigation ready');
    await run(`await ui.fill(asyncInput, 'current-query'); await ui.click(asyncButton, {waitFor: {text: 'Result: current-query', timeoutMs: 2000}});`);
    assert.equal(await context.pages()[0].locator('#result').textContent(), 'Result: current-query');
    const hitsBeforeTimeout = asyncHits.filter(kind => kind === 'click').length;
    await assert.rejects(executor.tool.execute('wait-timeout', { code: `await ui.click(asyncButton, {waitFor: {text: 'never-produced', timeoutMs: 800}});` }), /Timeout/);
    assert.equal(asyncHits.filter(kind => kind === 'click').length, hitsBeforeTimeout + 1, 'A readiness timeout must never replay its action');
    const hitsBeforeInvalid = asyncHits.length;
    await assert.rejects(executor.tool.execute('invalid-wait', { code: `await ui.click(asyncButton, {waitFor: {state: 'visible'}});` }), /Specify/);
    assert.equal(asyncHits.length, hitsBeforeInvalid, 'Invalid wait conditions must fail before the action');
    await assert.rejects(executor.tool.execute('fixed-page-wait', { code: 'var p=await ui.page(); await p.waitForTimeout(3000);' }), /Fixed browser delays/);
    await assert.rejects(executor.tool.execute('fixed-cell-wait', { code: 'await new Promise(r=>setTimeout(r,3000));' }), /Fixed browser delays/);
    await executor.tool.execute('explicit-timed-observation', { code: 'var p=await ui.page(); await p.waitForTimeout(200);', waitReason: 'The user explicitly requests a 200ms observation interval.' });
    await assert.rejects(executor.tool.execute('exception-does-not-leak', { code: 'await new Promise(r=>setTimeout(r,3000));' }), /Fixed browser delays/);
    const secret = await run('console.log("private-worker-token"); console.log(Object.keys(process.env));');
    assert.doesNotMatch(secret.content[0].text, /private-worker-token/);
  } finally {
    await executor?.close();
    await context.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
