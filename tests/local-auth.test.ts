import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '../src/server/auth.ts';
import { Store } from '../src/server/store.ts';

const token = 'local-auth-test-credential-'.repeat(3);

test('local authentication is explicit and refuses weak or public configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dots-local-auth-'));
  const store = new Store(directory);
  try {
    assert.equal(new AuthService(store, 4317, {}).localAuthAvailable(), false);
    const google = { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' };
    assert.equal(new AuthService(store, 4317, google).configured(), true);
    assert.equal(new AuthService(store, 4317, { ...google, DOTS_AUTH_MODE: 'local', DOTS_LOCAL_AUTH_TOKEN: token }).configured(), false);
    assert.throws(() => new AuthService(store, 4317, { DOTS_AUTH_MODE: 'typo' }), /DOTS_AUTH_MODE/);
    for (const value of ['', 'short', 'x'.repeat(257), ' '.repeat(40)]) {
      assert.throws(() => new AuthService(store, 4317, { DOTS_AUTH_MODE: 'local', DOTS_LOCAL_AUTH_TOKEN: value }), /DOTS_LOCAL_AUTH_TOKEN/);
    }
    for (const setting of ['DOTS_PUBLIC_HOST', 'DOTS_PUBLIC_ORIGIN']) {
      assert.throws(() => new AuthService(store, 4317, { DOTS_AUTH_MODE: 'local', DOTS_LOCAL_AUTH_TOKEN: token, [setting]: 'https://example.com' }), /loopback/);
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('local login creates opaque revocable sessions in a durable identity separate from Google', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dots-local-auth-'));
  let store = new Store(directory);
  let auth = new AuthService(store, 4317, { DOTS_AUTH_MODE: 'local', DOTS_LOCAL_AUTH_TOKEN: token });
  const server = createServer((req, res) => {
    if (req.url === '/login') return auth.localLogin(String(req.headers['x-test-token'] || ''), res);
    if (req.url === '/logout') { auth.logout(req, res); res.end(); return; }
    const session = auth.session(req);
    res.writeHead(session ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(session && { user: session.user, tenant: session.tenant }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const login = (value: string) => fetch(base + '/login', { headers: { 'x-test-token': value } });
  try {
    assert.equal(auth.configured(), false);
    assert.equal((await login('incorrect')).status, 401);
    assert.equal((await login('')).status, 401);
    const response = await login(token);
    assert.equal(response.status, 200);
    const header = response.headers.get('set-cookie')!;
    assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/);
    assert(!header.includes(token));
    const cookie = header.split(';')[0];
    const identity = await response.json();
    assert.equal(identity.tenant.role, 'owner');
    assert(!JSON.stringify(identity).includes(token));
    assert.equal((await fetch(base, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base, { headers: { cookie: 'coke_dots_session=' + token } })).status, 401);
    const google = store.signInGoogle({ subject: 'administrator', email: 'admin@localhost', name: 'Google user' });
    assert.notEqual(google.user.id, identity.user.id);
    assert.notEqual(google.tenant.id, identity.tenant.id);
    store.close(); store = new Store(directory);
    auth = new AuthService(store, 4317, { DOTS_AUTH_MODE: 'local', DOTS_LOCAL_AUTH_TOKEN: token + '-rotated' });
    assert.equal((await login(token)).status, 401);
    assert.deepEqual((await (await login(token + '-rotated')).json()).user, identity.user);
    assert.equal((await fetch(base, { headers: { cookie } })).status, 200);
    await fetch(base + '/logout', { headers: { cookie } });
    assert.equal((await fetch(base, { headers: { cookie } })).status, 401);
    auth = new AuthService(store, 4317, {});
    assert.equal((await login(token + '-rotated')).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
