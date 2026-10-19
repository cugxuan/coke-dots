import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SnapshotEvents } from '../src/server/snapshot-events.ts';
import { applySnapshotPatch, diffSnapshot, type SnapshotPatch } from '../src/shared/snapshot-patch.ts';
import type { Snapshot, Task } from '../src/shared/types.ts';

function snapshot(name = 'alpha'): Snapshot {
  return {
    profile: { name, avatarSetupCompletedAt: null, onboardingCompletedAt: null, onboardingCompletedName: null, shape: '', color: '', eyes: '', glasses: '', accessory: '', character: '', pet: '' },
    preferences: { desktopNotifications: false }, computerAccess: { dotComputer: true, localComputer: true, configured: false },
    tasks: [], entries: [], watches: [], configured: false, availableEngines: [], remoteEngines: [],
    modelSettings: { baseUrl: '', model: '', hasKey: false, adminTenantId: null, apiKeyStatus: 'missing' },
  };
}
function task(id: string, result: string | null = null): Task {
  return { id, tenantId: 'alpha', parentTaskId: null, engine: 'pi', agentSessionId: null, title: id, instruction: id, status: 'working', priority: 0, nextRunAt: null, scheduleMinutes: null, scheduleSpec: null, result, error: null, createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' };
}
class Client extends EventEmitter {
  frames: string[] = [];
  ended = false;
  writable = true;
  onWrite = () => {};
  write(frame: string) { this.onWrite(); this.frames.push(frame); return this.writable; }
  end() { this.ended = true; this.emit('close'); }
}
const session = (id: string) => ({ tenant: { id } });
const decode = <T = Snapshot>(frame: string) => JSON.parse(frame.split('data: ')[1]) as T;
function receive(current: Snapshot, frame: string) {
  return frame.startsWith('event: patch\n') ? applySnapshotPatch(current, decode<SnapshotPatch>(frame)) : decode(frame);
}

test('one publish reads and serializes each tenant once, but checks every live session', () => {
  const a = new Client(), b = new Client(), c = new Client();
  const reads: string[] = [], checks: string[] = [], serializations: string[] = [];
  const events = new SnapshotEvents(token => { checks.push(token); return session(token.split('-')[0]); }, tenant => {
    reads.push(tenant);
    return Object.assign(snapshot(tenant), { toJSON() { serializations.push(tenant); return snapshot(tenant); } });
  });
  events.connect(a, 'alpha-1'); events.connect(b, 'beta-1'); events.connect(c, 'alpha-2');
  reads.length = checks.length = serializations.length = 0;
  events.publish();
  assert.deepEqual(checks, ['alpha-1', 'beta-1', 'alpha-2']);
  assert.deepEqual(reads, ['alpha', 'beta']); assert.deepEqual(serializations, reads);
  assert.equal(a.frames[1], c.frames[1]); assert.equal(decode(b.frames[1]).profile.name, 'beta');
});

test('opted-in streams send just changed tasks and omit identical updates; legacy streams stay full', () => {
  const a = new Client(), legacy = new Client();
  let value = { ...snapshot(), tasks: [task('active'), task('history', 'private history')] };
  const events = new SnapshotEvents(session, () => value);
  events.connect(a, 'alpha', true); events.connect(legacy, 'alpha');
  events.publish(); assert.equal(a.frames.length, 1); assert.equal(legacy.frames.length, 2);
  const previous = value;
  value = { ...value, tasks: [{ ...task('active'), execution: { runId: 'run', startedAt: 'now', runs: 1, events: [{ id: 'phase', kind: 'status', message: '等待模型响应', at: 'now' }] } }, value.tasks[1]] };
  events.publish();
  assert(a.frames[1].startsWith('event: patch\n')); assert(!a.frames[1].includes('private history'));
  const next = receive(previous, a.frames[1]); assert.deepEqual(next, value);
  assert.equal(next.tasks[1], previous.tasks[1]); assert.equal(next.entries, previous.entries);
  assert.deepEqual(decode(legacy.frames[2]), value);
});

test('patches preserve additions, removals, priority order and the rolling entry window', () => {
  const previous = snapshot(); previous.tasks = [task('a'), task('b'), task('c')];
  previous.entries = [1, 2, 3].map(id => ({ id, tenantId: 'alpha', taskId: 'a', kind: 'dot', body: String(id), createdAt: 'now' }));
  previous.watches = [{ id: 'w', tenantId: 'alpha', url: 'https://example.test', intervalMinutes: 5, status: 'active', nextCheckAt: null, lastCheckedAt: null, lastStatus: null, error: null }];
  const next = { ...previous, tasks: [task('c'), task('new'), task('a', 'done')], entries: [previous.entries[2], { ...previous.entries[0], id: 4 }], watches: [] };
  assert.deepEqual(applySnapshotPatch(previous, diffSnapshot(previous, next)!), next);
  assert.deepEqual(applySnapshotPatch(next, diffSnapshot(next, snapshot())!), snapshot());
});

test('settings patches preserve false, null and empty values', () => {
  const previous = { ...snapshot(), configured: true, availableEngines: ['pi'] as const };
  const before: Snapshot = { ...previous, availableEngines: [...previous.availableEngines] };
  const next = snapshot('changed');
  assert.deepEqual(applySnapshotPatch(before, diffSnapshot(before, next)!), next);
  assert.equal(diffSnapshot(next, structuredClone(next)), null);
});

test('workspace changes and reconnects reset the baseline with complete authorized state', () => {
  let tenant = 'alpha';
  const events = new SnapshotEvents(() => session(tenant), name => ({ ...snapshot(name), tasks: [task('same-id', name)] }));
  const a = new Client(); events.connect(a, 'token', true);
  tenant = 'beta'; events.publish();
  assert(a.frames[1].startsWith('data: ')); assert.equal(decode(a.frames[1]).profile.name, 'beta');
  assert(!a.frames[1].includes('"result":"alpha"'));
  a.end(); const reconnect = new Client(); events.connect(reconnect, 'token', true);
  assert.deepEqual(decode(reconnect.frames[0]), decode(a.frames[1]));
  events.publish(); assert.equal(reconnect.frames.length, 1); assert.equal(a.frames.length, 2);
});

test('revoked sessions do not receive cached data from another connection', () => {
  let revoked = false;
  const a = new Client(), b = new Client();
  const events = new SnapshotEvents(token => token === 'revoked' && revoked ? null : session('alpha'), () => snapshot());
  events.connect(a, 'valid'); events.connect(b, 'revoked');
  a.onWrite = () => { revoked = true; };
  events.publish(); assert(b.ended); assert.equal(b.frames.length, 1);
});

test('a broken connection does not prevent delivery to the other clients', () => {
  const broken = new Client(), working = new Client();
  const events = new SnapshotEvents(session, () => snapshot());
  events.connect(broken, 'alpha'); events.connect(working, 'alpha');
  broken.onWrite = () => { throw new Error('socket closed'); };
  events.publish(); assert(broken.ended); assert.equal(working.frames.length, 2);
  events.publish(); assert.equal(working.frames.length, 3);
});

test('failed serialization closes the affected client without caching a partial result', () => {
  let fail = false, reads = 0;
  const events = new SnapshotEvents(session, () => {
    reads += 1;
    if (fail) { fail = false; return Object.assign(snapshot(), { toJSON() { throw new Error('failed'); } }); }
    return snapshot();
  });
  const a = new Client(), b = new Client(); events.connect(a, 'alpha'); events.connect(b, 'alpha');
  fail = true; reads = 0; events.publish(); assert(a.ended); assert.equal(reads, 2);
  assert.equal(b.frames.length, 2); assert.deepEqual(decode(b.frames[1]), snapshot());
});

test('slow connections coalesce all pending updates and diff from the last accepted frame', () => {
  let value = { ...snapshot(), tasks: [task('active', '0')] }, reads = 0;
  const events = new SnapshotEvents(session, () => { reads++; return value; });
  const a = new Client(); a.writable = false; events.connect(a, 'alpha', true);
  const initial = decode(a.frames[0]);
  for (let i = 1; i <= 100; i++) { value = { ...value, tasks: [task('active', String(i))] }; events.publish(); }
  events.heartbeat(); assert.equal(a.frames.length, 1); assert.equal(reads, 1);
  a.writable = true; a.emit('drain');
  assert.equal(a.frames.length, 2); assert.equal(reads, 2);
  assert.deepEqual(receive(initial, a.frames[1]), value);
  events.publish(); assert.equal(a.frames.length, 2);
});

test('a revoked session is checked again before draining pending changes', () => {
  let revoked = false;
  const events = new SnapshotEvents(() => revoked ? null : session('alpha'), () => snapshot());
  const a = new Client(); a.writable = false; events.connect(a, 'alpha', true); events.publish();
  revoked = true; a.emit('drain'); assert(a.ended); assert.equal(a.frames.length, 1);
});

test('draining a workspace change sends a full snapshot for the new workspace', () => {
  let tenant = 'alpha';
  const events = new SnapshotEvents(() => session(tenant), snapshot);
  const a = new Client(); a.writable = false; events.connect(a, 'token', true); events.publish();
  tenant = 'beta'; a.writable = true; a.emit('drain');
  assert(a.frames[1].startsWith('data: ')); assert.equal(decode(a.frames[1]).profile.name, 'beta');
});

test('closed connections cannot resume pending writes and heartbeat revokes blocked sessions', () => {
  let revoked = false, reads = 0;
  const events = new SnapshotEvents(() => revoked ? null : session('alpha'), () => { reads++; return snapshot(); });
  const a = new Client(); a.writable = false; events.connect(a, 'token'); events.publish(); a.end(); a.emit('drain');
  assert.equal(reads, 1);
  const b = new Client(); b.writable = false; events.connect(b, 'token'); revoked = true; events.heartbeat(); assert(b.ended);
  const c = new Client(); revoked = false; events.connect(c, 'token'); events.close(); assert(c.ended);
});

test('progress transfer size does not grow with unchanged task history', () => {
  const previous = { ...snapshot(), tasks: [task('active'), ...Array.from({ length: 100 }, (_, i) => task(`old-${i}`, '历史内容'.repeat(1000)))] };
  const next = { ...previous, tasks: [{ ...previous.tasks[0], status: 'done' as const, result: '完成' }, ...previous.tasks.slice(1)] };
  const patch = diffSnapshot(previous, next)!;
  assert(Buffer.byteLength(JSON.stringify(patch)) < 1000);
  assert(Buffer.byteLength(JSON.stringify(previous)) > 1_000_000);
  assert.deepEqual(applySnapshotPatch(previous, patch), next);
});
