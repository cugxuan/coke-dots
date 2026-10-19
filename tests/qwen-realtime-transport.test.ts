import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { QwenRealtimeTransport, QwenSignalingError } from '../src/web/qwen-realtime-transport.ts';
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const old = Object.fromEntries(['window', 'document', 'navigator', 'RTCPeerConnection'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const view = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const network = { onLine: true };
  const sent: { type: string; session?: unknown }[] = [];
  const peers: Peer[] = [];
  const status: string[] = [], errors: string[] = [];
  let ready = 0, lost = 0, negotiations = 0, events = 0, audio = 0;
  let acknowledge = true;
  let negotiate = async () => 'answer';
  const track = { enabled: false };
  class Channel {
    readyState = 'open';
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor(private peer: Peer) {}
    send(raw: string) {
      const event = JSON.parse(raw); sent.push(event);
      if (event.type === 'session.update' && acknowledge) this.peer.incoming.emit({ type: 'session.updated' });
    }
    emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
    close() { this.readyState = 'closed'; this.onclose?.(); }
  }
  class Peer {
    connectionState = 'new'; iceGatheringState = 'complete';
    localDescription?: unknown;
    outgoing = new Channel(this); incoming = new Channel(this);
    ondatachannel?: (event: { channel: Channel }) => void;
    ontrack?: (event: unknown) => void;
    onconnectionstatechange?: () => void;
    sender = { track: null as unknown, replaceTrack: async (value: unknown) => { this.sender.track = value; } };
    constructor() { peers.push(this); }
    addTransceiver() { return { sender: this.sender }; }
    createDataChannel() { return this.outgoing; }
    async createOffer() { return { type: 'offer', sdp: 'fixture' }; }
    async setLocalDescription(value: unknown) { this.localDescription = value; }
    async setRemoteDescription() {
      this.ondatachannel?.({ channel: this.incoming }); this.ontrack?.({});
      this.incoming.emit({ type: 'session.created' });
    }
    close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
    fail() { this.connectionState = 'failed'; this.onconnectionstatechange?.(); }
  }
  for (const [key, value] of Object.entries({ window: view, document, navigator: network, RTCPeerConnection: Peer })) Object.defineProperty(globalThis, key, { configurable: true, value });
  const transport = new QwenRealtimeTransport({
    track: track as MediaStreamTrack, config: () => ({ modalities: ['text', 'audio'] }),
    negotiate: async () => { negotiations++; return negotiate(); },
    ready: () => ready++, lost: () => lost++, status: text => status.push(text), fatal: text => errors.push(text),
    event: () => events++, audio: () => audio++,
  });
  t.after(() => { transport.close(); for (const [key, descriptor] of Object.entries(old)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  return { transport, peers, sent, status, errors, track, network, view, document,
    acknowledge: (value: boolean) => { acknowledge = value; }, negotiate: (fn: typeof negotiate) => { negotiate = fn; },
    get ready() { return ready; }, get lost() { return lost; }, get negotiations() { return negotiations; }, get events() { return events; }, get audio() { return audio; } };
}

test('Qwen checks a quiet provider without speech and replaces an expired connection using the same muted mic', async t => {
  const f = fixture(t); f.transport.start(); await tick();
  assert.equal(f.ready, 1);
  t.mock.timers.tick(30_000); await tick();
  assert.equal(f.sent.filter(e => e.type === 'session.update').length, 2);
  assert.deepEqual(f.sent.filter(e => e.type === 'session.update')[1].session, {}, 'A heartbeat must not resend immutable audio/VAD configuration');
  assert(!f.sent.some(e => e.type === 'response.create'));
  f.acknowledge(false); t.mock.timers.tick(30_000); t.mock.timers.tick(15_000); await tick();
  assert.equal(f.lost, 1); assert.equal(f.peers[0].connectionState, 'closed');
  f.acknowledge(true); t.mock.timers.tick(1000); await tick();
  assert.equal(f.ready, 2); assert.equal(f.negotiations, 2);
  assert.equal(f.peers[1].sender.track, f.track); assert.equal(f.track.enabled, false);
});

test('peer/channel failures coalesce and retired session events cannot trigger audio, tools or another reconnect', async t => {
  const f = fixture(t); f.transport.start(); await tick();
  const old = f.peers[0]; old.fail(); old.incoming.onerror?.(); old.outgoing.onerror?.();
  assert.equal(f.lost, 1);
  t.mock.timers.tick(1000); await tick();
  const events = f.events, audio = f.audio;
  old.incoming.emit({ type: 'response.done' }); old.ontrack?.({}); old.fail();
  assert.equal(f.events, events); assert.equal(f.audio, audio); assert.equal(f.lost, 1);
  assert.equal(f.ready, 2);
});

test('retry backs off, offline pauses it, online resumes and hangup cancels a pending negotiation', async t => {
  const f = fixture(t);
  f.negotiate(async () => { throw new Error('temporary outage'); }); f.transport.start(); await tick();
  t.mock.timers.tick(1000); await tick(); assert.equal(f.negotiations, 2);
  t.mock.timers.tick(1000); await tick(); assert.equal(f.negotiations, 2);
  f.network.onLine = false; t.mock.timers.tick(1000); await tick(); assert.equal(f.negotiations, 2);
  let answer!: (value: string) => void;
  f.negotiate(() => new Promise(resolve => { answer = resolve; }));
  f.network.onLine = true; f.view.dispatchEvent(new Event('online')); await tick();
  assert.equal(f.negotiations, 3);
  f.transport.close(); answer('late answer'); await tick(); t.mock.timers.tick(300_000); await tick();
  assert.equal(f.ready, 0); assert.equal(f.negotiations, 3);
});

test('missing setup acknowledgement times out and fatal auth failure does not retry', async t => {
  const f = fixture(t); f.acknowledge(false); f.transport.start(); await tick();
  t.mock.timers.tick(30_000); await tick(); assert.equal(f.lost, 1);
  f.negotiate(async () => { throw new QwenSignalingError('登录已过期', false); });
  t.mock.timers.tick(1000); await tick(); t.mock.timers.tick(300_000); await tick();
  assert.equal(f.negotiations, 2); assert.deepEqual(f.errors, ['登录已过期']);
});
