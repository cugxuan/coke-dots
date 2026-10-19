import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appLoginReturnUrl, appRoutePath, parseAppRoute } from '../src/shared/app-route.ts';
import { serveStatic } from '../src/server/http-utils.ts';

test('page links restore views, task/page context and scheduled selection under either mount', () => {
  const cases = [
    ['/', 'home', null, null, null], ['/chat', 'chat', null, null, null],
    ['/chat/task-1', 'chat', 'task-1', null, null], ['/chat/task-1?page=page-2', 'chat', 'task-1', 'page-2', null],
    ['/chat?page=page-2', 'chat', null, 'page-2', null],
    ['/pages', 'pages', null, null, null], ['/pages/page-2', 'pages', null, 'page-2', null],
    ['/activity', 'activity', null, null, null], ['/settings', 'profile', null, null, null],
    ['/scheduled', 'scheduled', null, null, null], ['/scheduled/tasks/task-1', 'scheduled', null, null, 'task:task-1'],
    ['/scheduled/watches/watch-2', 'scheduled', null, null, 'watch:watch-2'],
    ['/computer', 'computer', null, null, null], ['/computer?task=task-1', 'computer', 'task-1', null, null],
  ];
  for (const base of ['', '/dots-demo']) for (const [path, view, selected, selectedPageId, scheduledKey] of cases) {
    const url = new URL(`${base}${path}`, 'https://dots.example');
    const route = parseAppRoute(url.pathname, url.search, base);
    assert.deepEqual(route, { view, selected, selectedPageId, scheduledKey });
    assert.equal(appRoutePath(route!), path);
  }
});

test('unknown routes and malformed identifiers do not become app pages', () => {
  for (const path of ['/api/tasks', '/assets/missing.js', '/missing', '/chat/a/b', '/chat/%2Fetc', '/pages/%', '/scheduled/users/one', '/constructor', '/chat/', '/computer?task=../other', '/chat?page=%00']) {
    if (path === '/chat/') { assert.equal(parseAppRoute(path)?.view, 'chat'); continue; }
    const [pathname, search] = path.split('?');
    assert.equal(parseAppRoute(pathname, search), null, path);
  }
  assert.equal(parseAppRoute('/activity', '', '/dots-demo/'), null);
  assert.equal(parseAppRoute('/dots-demo-extra/chat', '', '/dots-demo/'), null);
});

test('OAuth returns to an app page without allowing redirects outside the configured mount', () => {
  const base = 'https://dots.example/dots-demo';
  assert.equal(appLoginReturnUrl(base, '/dots-demo/chat/task-1?page=page-2'), `${base}/chat/task-1?page=page-2`);
  assert.equal(appLoginReturnUrl('https://dots.example', '/activity'), 'https://dots.example/activity');
  for (const path of [null, '//evil.example/chat', '/\\evil.example/chat', 'https://evil.example/chat', '/activity', '/dots-demo/api/tasks', '/dots-demo/../settings', '/dots-demo/chat/%2Fbad']) {
    assert.equal(appLoginReturnUrl(base, path), `${base}/`, String(path));
  }
});

test('HTTP deep links serve the app while missing assets, API-like paths and non-GET requests keep errors', async () => {
  const previous = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), 'dots-routes-'));
  await mkdir(join(directory, 'dist', 'assets'), { recursive: true });
  await writeFile(join(directory, 'dist', 'index.html'), '<!doctype html><title>App route fixture</title>');
  await writeFile(join(directory, 'dist', 'assets', 'app.js'), 'export const fixture = true;');
  const server = createServer((req, res) => { void serveStatic(req, res, new URL(req.url!, 'http://localhost').pathname); });
  try {
    process.chdir(directory);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const path of ['/chat/task-1?page=page-2', '/pages/page-2', '/activity', '/scheduled/tasks/task-1', '/settings', '/computer?task=task-1']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type') || '', /text\/html/);
      assert.match(await response.text(), /App route fixture/);
    }
    assert.match(await (await fetch(`${origin}/assets/app.js`)).text(), /export const/);
    for (const path of ['/api/unknown', '/assets/missing.js', '/unknown', '/chat/task-1/extra']) assert.equal((await fetch(origin + path)).status, 404, path);
    assert.equal((await fetch(`${origin}/activity`, { method: 'POST' })).status, 405);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  }
});
