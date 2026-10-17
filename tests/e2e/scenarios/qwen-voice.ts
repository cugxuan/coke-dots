import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function qwenWebRtc(ctx: UiScenarioContext) {
  ctx.mockQwenSignalingUrl = await ctx.startMockQwenSignaling();
  await ctx.stopServer(ctx.server);
  ctx.server = await ctx.startServer(ctx.e2ePort, {
    DOTS_VOICE_PROVIDER: 'qwen',
    DOTS_QWEN_API_KEY: '',
    DOTS_QWEN_WORKSPACE_ID: '',
    DOTS_QWEN_REGION: '',
  });
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByTestId('profile-voice-call-launch').click();
  const unconfiguredCall = ctx.alphaPage!.getByTestId('voice-call');
  await unconfiguredCall.getByRole('alert').filter({ hasText: '百炼 API Key 和工作空间 ID；地域默认使用北京' }).waitFor({ state: 'visible' });
  await unconfiguredCall.getByRole('button', { name: '结束通话' }).click();

  await ctx.stopServer(ctx.server);
  ctx.server = await ctx.startServer(ctx.e2ePort, {
    DOTS_VOICE_PROVIDER: 'qwen',
    DOTS_QWEN_API_KEY: 'e2e-qwen-secret',
    DOTS_QWEN_WORKSPACE_ID: 'e2e-workspace',
    DOTS_QWEN_REGION: 'beijing',
    DOTS_E2E_QWEN_SIGNALING_URL: ctx.mockQwenSignalingUrl,
  });
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await ctx.openProfile(ctx.alphaPage!);
  const rtcMockScript = String.raw`(() => {
      const view = window;
      view.__dotsQwenSentEvents = [];
      const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } };
      view.__dotsQwenFakeTrack = track;
      view.__dotsQwenFakeSender = null;
      class FakeDataChannel {
        constructor(label) { this.label = label; this.readyState = 'connecting'; this.onopen = null; this.onmessage = null; this.onerror = null; }
        send(raw) {
          const event = JSON.parse(raw);
          view.__dotsQwenSentEvents.push(event);
          if (event.type === 'response.create') {
            view.__dotsQwenEventChannel?.emit({ type: 'response.created' });
            window.setTimeout(() => view.__dotsQwenEventChannel?.emit({ type: 'response.done' }), 60);
          }
        }
        emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
        close() { this.readyState = 'closed'; }
      }
      class FakePeerConnection {
        constructor() { this.iceGatheringState = 'complete'; this.connectionState = 'new'; this.localDescription = null; this.ondatachannel = null; this.ontrack = null; this.onconnectionstatechange = null; this.sendChannel = null; }
        addTransceiver(kind, options) {
          if (kind !== 'audio' || options?.direction !== 'sendrecv') throw new Error('Voice call must reserve bidirectional audio before SDP offer');
          const sender = { track: null, async replaceTrack(nextTrack) { this.track = nextTrack; } };
          view.__dotsQwenFakeSender = sender;
          return { sender };
        }
        createDataChannel(label) { this.sendChannel = new FakeDataChannel(label); return this.sendChannel; }
        async createOffer() { return { type: 'offer', sdp: ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', ''].join(String.fromCharCode(13, 10)) }; }
        async setLocalDescription(description) { this.localDescription = description; }
        async setRemoteDescription(description) {
          if (!description?.sdp?.startsWith('v=0')) throw new Error('Qwen answer SDP was not returned to the browser');
          const remote = new FakeDataChannel('txt');
          remote.readyState = 'open';
          view.__dotsQwenEventChannel = remote;
          this.ondatachannel?.({ channel: remote });
          remote.emit({ type: 'session.created' });
          this.sendChannel.readyState = 'open';
          this.sendChannel.onopen?.();
          view.__dotsQwenConfirmSession = () => remote.emit({ type: 'session.updated' });
        }
        close() { this.connectionState = 'closed'; }
      }
      Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: FakePeerConnection });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } });
    })()`;
  await ctx.alphaPage!.evaluate((script: string) => window.eval(script), rtcMockScript);
  await ctx.alphaPage!.getByTestId('profile-voice-call-launch').click();
  const call = ctx.alphaPage!.getByTestId('voice-call');
  await call.waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="voice-call"]')?.getAttribute('data-voice-provider') === 'qwen');
  await ctx.alphaPage!.waitForFunction(() => (window as unknown as { __dotsQwenSentEvents?: { type: string }[] }).__dotsQwenSentEvents?.some(event => event.type === 'session.update') === true, null, { timeout: 10_000 });
  assert.match(await call.locator('[data-testid="voice-call-transcript"]').innerText(), /正在初始化语音模型/, 'The UI must not report listening before model setup is acknowledged');
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenFakeSender: { track: unknown } }).__dotsQwenFakeSender.track), null, 'The microphone must remain detached until session.updated');
  await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenConfirmSession: () => void }).__dotsQwenConfirmSession());
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="voice-call-transcript"]')?.textContent?.includes('正在聆听') === true, null, { timeout: 10_000 });
  const microphoneAttachedAfterSetup = await ctx.alphaPage!.evaluate(() => {
    const view = window as unknown as { __dotsQwenFakeSender: { track: unknown }; __dotsQwenFakeTrack: unknown };
    return view.__dotsQwenFakeSender.track === view.__dotsQwenFakeTrack;
  });
  assert.equal(microphoneAttachedAfterSetup, true, 'The microphone should attach only after model configuration is acknowledged');
  const config = await ctx.alphaPage!.evaluate(async () => await fetch('/api/voice/provider').then(response => response.json())) as { provider: string; configured: boolean; apiKey?: string };
  assert.deepEqual(config, { provider: 'qwen', configured: true, model: 'qwen3.8-omni-flash-realtime' });
  assert.equal(ctx.mockQwenSignalingRequests.length, 1, 'The browser must complete server-side Qwen SDP negotiation before listening');
  assert.deepEqual(ctx.mockQwenSignalingRequests[0], {
    authorization: 'Bearer e2e-qwen-secret', contentType: 'application/sdp',
    sdp: ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', ''].join(String.fromCharCode(13, 10)),
  });
  const sessionUpdate = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenSentEvents: { type: string; session?: { input_audio_transcription?: { model?: string }; turn_detection?: { type?: string } } }[] }).__dotsQwenSentEvents.find(event => event.type === 'session.update'));
  assert.equal(sessionUpdate?.session?.input_audio_transcription?.model, 'qwen3-asr-flash-realtime');
  assert.equal(sessionUpdate?.session?.turn_detection?.type, 'server_vad');
  await call.getByRole('button', { name: '静音' }).click();
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenFakeTrack: { enabled: boolean } }).__dotsQwenFakeTrack.enabled), false, 'Mute must disable the live microphone track');
  await call.getByRole('button', { name: '取消静音' }).click();
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenFakeTrack: { enabled: boolean } }).__dotsQwenFakeTrack.enabled), true, 'Unmute must re-enable the live microphone track');
  const voiceTurnTranscript = 'E2E voice response — speak actual task result';
  const voiceTurnId = 'item-e2e-qwen-voice-turn-001';
  await ctx.alphaPage!.evaluate(({ transcript, turnId }) => {
    const view = window as unknown as { __dotsQwenEventChannel: { emit(event: unknown): void } };
    view.__dotsQwenEventChannel.emit({ type: 'input_audio_buffer.speech_started' });
    const completed = { type: 'conversation.item.input_audio_transcription.completed', event_id: 'event-e2e-qwen-voice-turn-001', item_id: turnId, transcript };
    view.__dotsQwenEventChannel.emit(completed);
    view.__dotsQwenEventChannel.emit(completed);
    view.__dotsQwenEventChannel.emit({ type: 'response.created' });
    window.setTimeout(() => view.__dotsQwenEventChannel.emit({ type: 'response.done' }), 700);
  }, { transcript: voiceTurnTranscript, turnId: voiceTurnId });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="voice-call-transcript"]')?.getAttribute('data-task-status')?.includes('已完成') === true, null, { timeout: 20_000 });
  await ctx.alphaPage!.waitForFunction(() => (window as unknown as { __dotsQwenSentEvents?: { type: string; item?: { content?: { text?: string }[] } }[] }).__dotsQwenSentEvents?.some(event => event.type === 'conversation.item.create' && event.item?.content?.some(part => part.text?.includes('Voice response returned from the model.'))) === true, null, { timeout: 10_000 });
  const agentPrompt = ctx.mockModelPrompts.find(prompt => prompt.includes('E2E voice response — speak actual task result')) || '';
  assert(agentPrompt, 'The recognized Chinese speech was not dispatched through the tenant Agent task path');
  const turnResult = await ctx.alphaPage!.evaluate(async ({ transcript, turnId }) => {
    const callResponse = await fetch('/api/voice-calls');
    const calls = await callResponse.json() as { id: string; startedAt: string; endedAt: string | null }[];
    const activeCall = calls.find(candidate => !candidate.endedAt);
    if (!activeCall) throw new Error('No active call was recorded for the voice turn');
    const response = await fetch(`/api/voice-calls/${activeCall.id}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript, turnId, engine: 'pi' }),
    });
    return { status: response.status, callId: activeCall.id, callStartedAt: activeCall.startedAt, task: await response.json() as { id: string } };
  }, { transcript: voiceTurnTranscript, turnId: voiceTurnId });
  assert.equal(turnResult.status, 200, 'A replayed transcript turn should return the original task');
  const crossTenantTurnStatus = await ctx.betaPage!.evaluate(async ({ callId, transcript, turnId }) => (await fetch(`/api/voice-calls/${callId}/turns`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transcript, turnId, engine: 'pi' }),
  })).status, { callId: turnResult.callId, transcript: voiceTurnTranscript, turnId: voiceTurnId });
  assert.equal(crossTenantTurnStatus, 404, 'A different tenant cannot inspect or replay another user’s voice turn');
  const voiceTaskCheck = await ctx.alphaPage!.evaluate(async ({ transcript, callStartedAt }) => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; instruction: string; createdAt: string }[] };
    const tasks = state.tasks.filter(task => task.instruction === transcript && Date.parse(task.createdAt) >= Date.parse(callStartedAt));
    return { count: tasks.length, taskId: tasks[0]?.id };
  }, { transcript: voiceTurnTranscript, callStartedAt: turnResult.callStartedAt });
  assert.equal(voiceTaskCheck.taskId, turnResult.task.id, 'The replay response must reference the task started for this call');
  const voiceTaskCount = voiceTaskCheck.count;
  assert.equal(voiceTaskCount, 1, 'Repeated WebRTC transcript delivery must not start a second Agent task');
  await ctx.screenshot(ctx.alphaPage!, 'qwen-realtime-call-agent-result');
  await call.getByRole('button', { name: '结束通话' }).click();
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenFakeTrack: { stopped: boolean } }).__dotsQwenFakeTrack.stopped), true, 'Ending the call must stop the microphone track');
  const callHistory = await ctx.alphaPage!.evaluate(async () => await fetch('/api/voice-calls').then(response => response.json())) as { endedAt: string | null }[];
  assert(callHistory.some(item => item.endedAt), 'The Qwen call should be durably recorded when it ends');

  await ctx.alphaPage!.evaluate("Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async function () { throw new Error('E2E microphone permission denied'); } } })");
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByTestId('profile-voice-call-launch').click();
  const failedCall = ctx.alphaPage!.getByTestId('voice-call');
  await failedCall.waitFor({ state: 'visible' });
  await failedCall.getByRole('alert').filter({ hasText: 'E2E microphone permission denied' }).waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(async () => {
    const calls = await fetch('/api/voice-calls').then(response => response.json()) as { endedAt: string | null }[];
    return Boolean(calls[0]?.endedAt);
  }, null, { timeout: 10_000 });
  const failedCallHistory = await ctx.alphaPage!.evaluate(async () => await fetch('/api/voice-calls').then(response => response.json())) as { endedAt: string | null }[];
  assert(failedCallHistory[0]?.endedAt, 'A Qwen call that fails during microphone startup must not remain active in call history');
  await failedCall.getByRole('button', { name: '结束通话' }).click();
  await failedCall.waitFor({ state: 'detached' });
}
