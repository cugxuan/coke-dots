import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishSnapshots } from '../src/server/snapshot-events.ts';

function client(onWrite?: () => void) {
  return {
    frames: [] as string[],
    ended: false,
    write(frame: string) { onWrite?.(); this.frames.push(frame); },
    end() { this.ended = true; },
  };
}

test('one publish queries and serializes each tenant once while checking every session', () => {
  const a = client();
  const b = client();
  const c = client();
  const checks: string[] = [];
  const reads: string[] = [];
  const serializations: string[] = [];
  const clients = new Map([[a, 'alpha-1'], [b, 'beta-1'], [c, 'alpha-2']]);
  publishSnapshots(clients, token => {
    checks.push(token);
    return { tenant: { id: token.split('-')[0] } };
  }, tenantId => {
    reads.push(tenantId);
    return { toJSON() { serializations.push(tenantId); return { tenantId, privateValue: `${tenantId}-only` }; } };
  });
  assert.deepEqual(checks, ['alpha-1', 'beta-1', 'alpha-2']);
  assert.deepEqual(reads, ['alpha', 'beta']);
  assert.deepEqual(serializations, reads);
  assert.deepEqual(a.frames, c.frames);
  assert.deepEqual(a.frames, ['data: {"tenantId":"alpha","privateValue":"alpha-only"}\n\n']);
  assert.deepEqual(b.frames, ['data: {"tenantId":"beta","privateValue":"beta-only"}\n\n']);
});

test('later publishes refresh data and follow the current workspace for each connection', () => {
  const a = client();
  const b = client();
  const clients = new Map([[a, 'moving-session'], [b, 'stable-session']]);
  let activeTenant = 'alpha';
  let revision = 1;
  const getSession = (token: string) => ({ tenant: { id: token === 'moving-session' ? activeTenant : 'alpha' } });
  const snapshot = (tenantId: string) => ({ tenantId, revision });
  publishSnapshots(clients, getSession, snapshot);
  activeTenant = 'beta';
  revision = 2;
  publishSnapshots(clients, getSession, snapshot);
  assert.deepEqual(a.frames, ['data: {"tenantId":"alpha","revision":1}\n\n', 'data: {"tenantId":"beta","revision":2}\n\n']);
  assert.deepEqual(b.frames, ['data: {"tenantId":"alpha","revision":1}\n\n', 'data: {"tenantId":"alpha","revision":2}\n\n']);
});

test('revoked sessions cannot receive an already cached tenant snapshot', () => {
  let revoked = false;
  const a = client(() => { revoked = true; });
  const b = client();
  const clients = new Map([[a, 'valid'], [b, 'revoked']]);
  publishSnapshots(clients, token => token === 'revoked' && revoked ? null : { tenant: { id: 'alpha' } }, () => ({ privateValue: 'alpha-only' }));
  assert.equal(b.ended, true);
  assert.equal(clients.has(b), false);
  assert.deepEqual(b.frames, []);
  assert.equal(a.frames.length, 1);
});

test('a broken connection is removed without preventing delivery to other clients', () => {
  const broken = client(() => { throw new Error('socket closed'); });
  const working = client();
  const clients = new Map([[broken, 'first'], [working, 'second']]);
  let reads = 0;
  publishSnapshots(clients, () => ({ tenant: { id: 'alpha' } }), () => { reads += 1; return { ready: true }; });
  assert.equal(broken.ended, true);
  assert.equal(clients.has(broken), false);
  assert.equal(reads, 1);
  assert.deepEqual(working.frames, ['data: {"ready":true}\n\n']);
});

test('failed serialization closes the affected client and does not cache a partial result', () => {
  const broken = client();
  const retry = client();
  const other = client();
  const clients = new Map([[broken, 'alpha'], [retry, 'alpha'], [other, 'beta']]);
  let reads = 0;
  publishSnapshots(clients, token => ({ tenant: { id: token } }), tenantId => {
    reads += 1;
    if (reads === 1) return { toJSON() { throw new Error('snapshot unavailable'); } };
    return { tenantId };
  });
  assert.equal(broken.ended, true);
  assert.equal(clients.has(broken), false);
  assert.equal(reads, 3);
  assert.deepEqual(retry.frames, ['data: {"tenantId":"alpha"}\n\n']);
  assert.deepEqual(other.frames, ['data: {"tenantId":"beta"}\n\n']);
});
