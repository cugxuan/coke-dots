import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';

export const qwenLongVoiceResult = '逐条核验记录和资料来源，完整明细保留在聊天中。'.repeat(100) + '\n最终结论：17 条已核实，3 条仍待确认。';
export const qwenLongVoiceSummary = '17 条记录已核实，3 条仍待确认。完整内容见聊天。';
export const qwenInterruptionReleases = new Map<string, () => void>();

export async function qwenWebRtc(ctx: UiScenarioContext, model = 'qwen3.8-omni-flash-realtime') {
  ctx.mockQwenSignalingUrl = await ctx.startMockQwenSignaling();
  await ctx.stopServer(ctx.server);
  ctx.server = await ctx.startServer(ctx.e2ePort, {
    DOTS_VOICE_PROVIDER: 'qwen',
    DOTS_QWEN_MODEL: model,
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
    DOTS_QWEN_MODEL: model,
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
      view.__dotsQwenAudioResponses = [];
      view.__dotsQwenHoldAudioCreated = false;
      view.__dotsQwenHoldAudioDone = false;
      class FakeAudio {
        constructor() { this.muted = false; view.__dotsQwenAudio = this; }
        setAttribute() {}
        async play() {}
        pause() {}
      }
      Object.defineProperty(window, 'Audio', { configurable: true, value: FakeAudio });
      const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } };
      view.__dotsQwenFakeTrack = track;
      view.__dotsQwenFakeSender = null;
      class FakeDataChannel {
        constructor(label) { this.label = label; this.readyState = 'connecting'; this.onopen = null; this.onmessage = null; this.onerror = null; }
        send(raw) {
          const event = JSON.parse(raw);
          view.__dotsQwenSentEvents.push(event);
          if (event.type === 'response.create') {
            const response = { id: 'audio-' + view.__dotsQwenAudioResponses.length, modalities: event.response.modalities };
            view.__dotsQwenAudioResponses.push(response);
            if (!view.__dotsQwenHoldAudioCreated) view.__dotsQwenEventChannel?.emit({ type: 'response.created', response });
            if (!view.__dotsQwenHoldAudioDone) window.setTimeout(() => view.__dotsQwenEventChannel?.emit({ type: 'response.done', response }), 60);
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
          this.ontrack?.({ streams: [{}] });
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
  assert.deepEqual(config, { provider: 'qwen', configured: true, model });
  assert.equal(ctx.mockQwenSignalingRequests.length, 1, 'The browser must complete server-side Qwen SDP negotiation before listening');
  assert.deepEqual(ctx.mockQwenSignalingRequests[0], {
    authorization: 'Bearer e2e-qwen-secret', contentType: 'application/sdp',
    sdp: ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', ''].join(String.fromCharCode(13, 10)),
  });
  const sessionUpdate = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenSentEvents: { type: string; session?: { modalities?: string[]; voice?: string; audio?: unknown; input_audio_transcription?: { model?: string }; turn_detection?: { type?: string } } }[] }).__dotsQwenSentEvents.find(event => event.type === 'session.update'));
  assert.deepEqual(sessionUpdate?.session?.modalities, ['text'], 'Automatic VAD responses cannot contain audio');
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenSentEvents: { type: string }[] }).__dotsQwenSentEvents.some(event => event.type === 'response.create')), false, 'No greeting or answer is generated before a Dot result');
  if (model === 'qwen-audio-3.0-realtime-plus') {
    assert.equal(sessionUpdate?.session?.voice, 'longanqian');
    assert.equal(sessionUpdate?.session?.audio, undefined);
    assert.equal(sessionUpdate?.session?.input_audio_transcription, undefined);
  } else assert.equal(sessionUpdate?.session?.input_audio_transcription?.model, 'qwen3-asr-flash-realtime');
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
    view.__dotsQwenEventChannel.emit({ type: 'response.created', response: { modalities: ['text'] } });
    window.setTimeout(() => view.__dotsQwenEventChannel.emit({ type: 'response.done', response: { modalities: ['text'] } }), 700);
  }, { transcript: voiceTurnTranscript, turnId: voiceTurnId });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="voice-call-transcript"]')?.getAttribute('data-task-status')?.includes('已完成') === true, null, { timeout: 20_000 });
  await ctx.alphaPage!.waitForFunction(() => (window as unknown as { __dotsQwenSentEvents?: { type: string; item?: { content?: { text?: string }[] } }[] }).__dotsQwenSentEvents?.some(event => event.type === 'conversation.item.create' && event.item?.content?.some(part => part.text?.includes('Voice response returned from the model.'))) === true, null, { timeout: 10_000 });
  const spokenResponses = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenSentEvents: { type: string; response?: { modalities?: string[] } }[] }).__dotsQwenSentEvents.filter(event => event.type === 'response.create'));
  assert.equal(spokenResponses.length, 1, 'Only the actual Dot result should be spoken');
  assert.deepEqual(spokenResponses[0].response?.modalities, ['text', 'audio']);
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
  const speechResponse = await ctx.alphaPage!.evaluate(async ({ callId, taskId }) => {
    const response = await fetch(`/api/voice-calls/${callId}/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }) });
    return { status: response.status, body: await response.json() };
  }, { callId: turnResult.callId, taskId: turnResult.task.id });
  assert.deepEqual(speechResponse, { status: 200, body: { text: 'Voice response returned from the model.', summarized: false } });
  const crossTenantSpeechStatus = await ctx.betaPage!.evaluate(async ({ callId, taskId }) => (await fetch(`/api/voice-calls/${callId}/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }) })).status, { callId: turnResult.callId, taskId: turnResult.task.id });
  assert.equal(crossTenantSpeechStatus, 404);
  const voiceTaskCheck = await ctx.alphaPage!.evaluate(async ({ transcript, callStartedAt }) => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; instruction: string; createdAt: string }[] };
    const tasks = state.tasks.filter(task => task.instruction === transcript && Date.parse(task.createdAt) >= Date.parse(callStartedAt));
    return { count: tasks.length, taskId: tasks[0]?.id };
  }, { transcript: voiceTurnTranscript, callStartedAt: turnResult.callStartedAt });
  assert.equal(voiceTaskCheck.taskId, turnResult.task.id, 'The replay response must reference the task started for this call');
  const voiceTaskCount = voiceTaskCheck.count;
  assert.equal(voiceTaskCount, 1, 'Repeated WebRTC transcript delivery must not start a second Agent task');
  await ctx.alphaPage!.evaluate(() => {
    const view = window as unknown as { __dotsQwenEventChannel: { emit(event: unknown): void } };
    view.__dotsQwenEventChannel.emit({ type: 'input_audio_buffer.speech_started' });
    view.__dotsQwenEventChannel.emit({ type: 'response.created', response: { modalities: ['text'] } });
    view.__dotsQwenEventChannel.emit({ type: 'response.done', response: { modalities: ['text'] } });
    view.__dotsQwenEventChannel.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-e2e-qwen-long-002', transcript: 'E2E voice long response — summarize actual task result' });
  });
  await ctx.alphaPage!.waitForFunction(summary => (window as unknown as { __dotsQwenSentEvents?: { type: string; item?: { content?: { text?: string }[] } }[] }).__dotsQwenSentEvents?.some(event => event.type === 'conversation.item.create' && event.item?.content?.some(part => part.text?.includes(summary))) === true, qwenLongVoiceSummary, { timeout: 20_000 });
  const longResult = await ctx.alphaPage!.evaluate(async () => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { instruction: string; result: string }[] };
    return state.tasks.find(task => task.instruction === 'E2E voice long response — summarize actual task result')?.result;
  });
  assert.equal(longResult, qwenLongVoiceResult, 'The full result must remain in chat data while only the summary is spoken');
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenSentEvents: { type: string }[] }).__dotsQwenSentEvents.filter(event => event.type === 'response.create').length), 2);
  await qwenInterruption(ctx, model);
  await ctx.screenshot(ctx.alphaPage!, 'qwen-realtime-call-agent-result');
  await call.getByRole('button', { name: '结束通话' }).click();
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenFakeTrack: { stopped: boolean } }).__dotsQwenFakeTrack.stopped), true, 'Ending the call must stop the microphone track');
  const callHistory = await ctx.alphaPage!.evaluate(async () => await fetch('/api/voice-calls').then(response => response.json())) as { endedAt: string | null }[];
  assert(callHistory.some(item => item.endedAt), 'The Qwen call should be durably recorded when it ends');
  assert.equal(await ctx.alphaPage!.evaluate(async ({ callId, taskId }) => (await fetch(`/api/voice-calls/${callId}/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }) })).status, { callId: turnResult.callId, taskId: turnResult.task.id }), 404, 'Ended calls cannot start new speech preparation');

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

interface QwenInterruptionWindow extends Window {
  __dotsQwenEventChannel: { emit(event: unknown): void };
  __dotsQwenSentEvents: { type: string; item?: { content?: { text?: string }[] } }[];
  __dotsQwenAudioResponses: { id: string; modalities: string[] }[];
  __dotsQwenAudio: { muted: boolean };
  __dotsQwenHoldAudioCreated: boolean;
  __dotsQwenHoldAudioDone: boolean;
}

async function qwenInterruption(ctx: UiScenarioContext, model: string) {
  const page = ctx.alphaPage!;
  const call = page.getByTestId('voice-call');
  const instruction = (name: string) => `E2E voice interruption ${name} ${model}`;
  const emit = (events: unknown[]) => page.evaluate(events => {
    for (const event of events) (window as unknown as QwenInterruptionWindow).__dotsQwenEventChannel.emit(event);
  }, events);
  const start = (name: string) => emit([{ type: 'input_audio_buffer.speech_started', item_id: name }]);
  const complete = (name: string, finishResponse = true) => emit([
    { type: 'conversation.item.input_audio_transcription.completed', item_id: name, transcript: instruction(name) },
    { type: 'response.created', response: { id: `text-${name}`, modalities: ['text'] } },
    ...(finishResponse ? [{ type: 'response.done', response: { id: `text-${name}`, modalities: ['text'] } }] : []),
  ]);
  const input = async (name: string, finishResponse = true) => { await start(name); await complete(name, finishResponse); };
  const waitDone = async (name: string) => {
    await page.waitForFunction(async instruction => {
      const state = await fetch('/api/state').then(response => response.json());
      return state.tasks.some((task: { instruction: string; status: string }) => task.instruction === instruction && task.status === 'done');
    }, instruction(name));
    await page.locator('.timeline .message.dot').filter({ hasText: `Voice interruption result: ${name}.` }).last().waitFor({ state: 'visible' });
  };
  const spoken = () => page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.filter(event => event.type === 'response.create').length);
  const waitSpoken = (count: number) => page.waitForFunction(count => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.filter(event => event.type === 'response.create').length === count, count);
  let count = await spoken();

  // A completed result queued behind the automatic text response is obsolete
  // as soon as the user starts speaking, before the next transcript arrives.
  await input('queued', false);
  await waitDone('queued');
  await start('after-queue');
  await start('after-queue'); // Duplicate VAD delivery cannot leave a phantom pending turn.
  await emit([{ type: 'response.done', response: { id: 'text-queued', modalities: ['text'] } }]);
  assert.equal(await spoken(), count, 'An interrupted queued result must never be submitted for speech');
  await complete('after-queue');
  await waitSpoken(++count);

  // A real accepted Agent job completes later. It must still persist and render
  // in chat, without speaking or overwriting the foreground call status.
  await input('late-task');
  await ctx.waitFor(() => qwenInterruptionReleases.has('late-task'), 10_000);
  await start('after-task');
  qwenInterruptionReleases.get('late-task')!();
  await waitDone('late-task');
  assert.equal(await spoken(), count, 'A superseded job must finish silently');
  assert.equal(await page.getByTestId('voice-call-transcript').getAttribute('data-task-status'), '', 'A background completion must not replace the listening status');
  await complete('after-task');
  await waitSpoken(++count);

  // The task creation response itself can arrive after interruption.
  let releaseAcceptance = () => {};
  const acceptanceGate = new Promise<void>(resolve => { releaseAcceptance = resolve; });
  let acceptanceHeld = false;
  let acceptanceReleased = false;
  const turnRoute = '**/api/voice-calls/*/turns';
  await page.route(turnRoute, async route => {
    if (route.request().postDataJSON().turnId !== 'late-acceptance') { await route.continue(); return; }
    const response = await route.fetch();
    acceptanceHeld = true;
    await acceptanceGate;
    await route.fulfill({ response });
    acceptanceReleased = true;
  });
  try {
    await input('late-acceptance');
    await ctx.waitFor(() => acceptanceHeld, 10_000);
    await start('after-acceptance');
    releaseAcceptance();
    await ctx.waitFor(() => acceptanceReleased, 10_000);
    await waitDone('late-acceptance');
    await complete('after-acceptance');
    await waitSpoken(++count);
    assert.equal(await spoken(), count, 'Late task acceptance must not reattach an obsolete speech follower');
  } finally { releaseAcceptance(); await page.unroute(turnRoute); }

  // The summary is already being prepared when the user interrupts. Even an
  // eventual successful response must produce neither speech nor fallback text.
  let releaseSummary = () => {};
  const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
  let summaryHeld = false;
  let summaryReleased = false;
  const speechRoute = '**/api/voice-calls/*/speech';
  await page.route(speechRoute, async route => {
    const response = await route.fetch();
    summaryHeld = true;
    await summaryGate;
    try { await route.fulfill({ response }); } catch { /* The app aborted this obsolete fetch. */ }
    summaryReleased = true;
  });
  try {
    await input('summary');
    await ctx.waitFor(() => summaryHeld, 10_000);
    await start('after-summary');
    releaseSummary();
    await ctx.waitFor(() => summaryReleased, 10_000);
    await complete('after-summary');
    await waitSpoken(++count);
    assert.equal(await spoken(), count, 'An interrupted summary cannot speak, including its failure fallback');
  } finally { releaseSummary(); await page.unroute(speechRoute); }

  // Keep audio active, then deliver the previous cancellation after a new text
  // response has started. Real cancellation events can omit modalities.
  await page.evaluate(() => { (window as unknown as QwenInterruptionWindow).__dotsQwenHoldAudioDone = true; });
  await input('playing');
  await waitSpoken(++count);
  assert.equal(await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudio.muted), false);
  const playing = await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudioResponses.at(-1)!);
  await start('after-playing');
  assert.equal(await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudio.muted), true, 'Speech start must mute residual WebRTC audio immediately');
  await call.getByRole('button', { name: '关闭扬声器' }).click();
  await call.getByRole('button', { name: '打开扬声器' }).click();
  assert.equal(await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudio.muted), true, 'Toggling the speaker must not resurrect interrupted audio');
  await complete('after-playing', false);
  const cancellation = { type: 'response.done', response: { id: playing.id, status: 'cancelled' } };
  await emit([cancellation, cancellation]);
  await waitDone('after-playing');
  assert.equal(await spoken(), count, 'Old audio cancellation must not consume the current pending text response');
  await emit([{ type: 'response.done', response: { id: 'text-after-playing', modalities: ['text'] } }]);
  await waitSpoken(++count);
  assert.equal(await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudio.muted), false, 'Only fresh task speech may reopen the audio output');
  await emit([cancellation]);
  const freshPlaying = await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudioResponses.at(-1)!);
  await emit([{ type: 'response.done', response: freshPlaying }]);

  // Interruption may even beat response.created for a speech request.
  await page.evaluate(() => { (window as unknown as QwenInterruptionWindow).__dotsQwenHoldAudioCreated = true; });
  await input('late-created');
  await waitSpoken(++count);
  const late = await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudioResponses.at(-1)!);
  await start('after-created');
  await emit([{ type: 'response.created', response: late }]);
  assert.equal(await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudio.muted), true, 'Late response.created must not unmute superseded audio');
  await emit([{ type: 'response.done', response: { id: late.id, status: 'cancelled' } }]);
  await page.evaluate(() => {
    const view = window as unknown as QwenInterruptionWindow;
    view.__dotsQwenHoldAudioCreated = false;
    view.__dotsQwenHoldAudioDone = false;
  });
  await complete('after-created');
  await waitSpoken(++count);
  const texts = await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.flatMap(event => event.item?.content?.map(part => part.text || '') || []));
  for (const obsolete of ['queued', 'late-task', 'late-acceptance']) assert(!texts.some(text => text.includes(`Voice interruption result: ${obsolete}.`)), `Obsolete ${obsolete} result must never enter the provider conversation`);
  assert.equal(texts.filter(text => text.includes(qwenLongVoiceSummary)).length, 1, 'Only the original uninterrupted long result should have been summarized aloud');
}
