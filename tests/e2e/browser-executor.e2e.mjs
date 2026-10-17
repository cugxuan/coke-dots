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
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/v1/')) {
      assert.equal(req.headers.authorization, 'Bearer private-worker-token');
      const pages = await (await fetch(`${cdpUrl}/json/list`)).json();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ owner, targetId: pages.find(p => p.type === 'page').id }));
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
    const waiting = executor.tool.execute('takeover', { code: 'await new Promise(resolve => setTimeout(resolve, 15000)); await ui.open("https://example.invalid");' });
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
    const secret = await run('console.log("private-worker-token"); console.log(Object.keys(process.env));');
    assert.doesNotMatch(secret.content[0].text, /private-worker-token/);
  } finally {
    await executor?.close();
    await context.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
