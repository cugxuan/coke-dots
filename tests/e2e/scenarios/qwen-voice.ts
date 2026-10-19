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
      view.__dotsQwenExtraStreams = 0;
      view.__dotsQwenPeers = [];
      // Keep long-task regression practical: a former 15-minute expiry becomes
      // observable while the server deliberately holds this task's completion.
      const nativeTimeout = window.setTimeout.bind(window);
      view.__dotsRestoreTimeout = () => { window.setTimeout = nativeTimeout; };
      window.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, delay === 15 * 60 * 1000 ? 100 : delay, ...args);
      // Chat's existing stream is already connected. Speech must consume those
      // same updates even if opening another progress connection would fail.
      const NativeEventSource = window.EventSource;
      view.__dotsRestoreEventSource = () => { window.EventSource = NativeEventSource; };
      window.EventSource = class { constructor() { view.__dotsQwenExtraStreams++; throw new Error('Redundant voice progress stream'); } };
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
          if (event.type === 'session.update' && view.__dotsQwenConfirmed) view.__dotsQwenEventChannel?.emit({ type: 'session.updated' });
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
        constructor() { view.__dotsQwenPeers.push(this); view.__dotsQwenConfirmed = false; this.iceGatheringState = 'complete'; this.connectionState = 'new'; this.localDescription = null; this.ondatachannel = null; this.ontrack = null; this.onconnectionstatechange = null; this.sendChannel = null; }
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
          view.__dotsQwenConfirmSession = () => { view.__dotsQwenConfirmed = true; remote.emit({ type: 'session.updated' }); };
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
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudioResponses.length), 0, 'No greeting can start before the model is ready');
  await ctx.alphaPage!.evaluate(() => {
    const confirm = (window as unknown as { __dotsQwenConfirmSession: () => void }).__dotsQwenConfirmSession;
    confirm(); confirm();
  });
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
  assert.deepEqual(sessionUpdate?.session?.modalities, ['text', 'audio'], 'The secretary must answer directly without an Agent task');
  const greetingTexts = await ctx.alphaPage!.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.flatMap(event => event.item?.content?.map(part => part.text || '') || []));
  assert.equal(greetingTexts.length, 1, 'Repeated setup acknowledgements must produce exactly one greeting');
  assert(greetingTexts[0].includes('有什么我可以帮你？'), 'The connected call must greet the user explicitly');
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
  const beforeDirect = await ctx.alphaPage!.evaluate(async () => { const s = await fetch('/api/state').then(r => r.json()); return { tasks: s.tasks.length, messages: s.entries.filter((e: { body: string }) => e.body === '你好，秘书').length }; });
  await ctx.alphaPage!.evaluate(() => {
    const channel = (window as unknown as QwenInterruptionWindow).__dotsQwenEventChannel;
    channel.emit({ type: 'input_audio_buffer.speech_started', item_id: 'direct-input' });
    channel.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'direct-input', transcript: '你好，秘书' });
    channel.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'direct-input', transcript: '你好，秘书' });
    channel.emit({ type: 'response.created', response: { id: 'direct-answer', modalities: ['text', 'audio'] } });
    channel.emit({ type: 'response.audio_transcript.done', response_id: 'direct-answer', item_id: 'direct-message', transcript: '你好，有什么需要帮忙？' });
    channel.emit({ type: 'response.done', response: { id: 'direct-answer', status: 'completed' } });
  });
  await ctx.alphaPage!.waitForFunction(async () => (await fetch('/api/state').then(r => r.json())).entries.some((e: { body: string }) => e.body === '你好，有什么需要帮忙？'));
  const direct = await ctx.alphaPage!.evaluate(async () => {
    const state = await fetch('/api/state').then(r => r.json());
    return { tasks: state.tasks.length, userMessages: state.entries.filter((e: { body: string }) => e.body === '你好，秘书').length };
  });
  assert.equal(direct.tasks, beforeDirect.tasks, 'Small talk must not run the Agent');
  assert.equal(direct.userMessages, beforeDirect.messages + 1, 'Duplicate input transcripts must persist once');
  const voiceTurnTranscript = 'E2E voice response — speak actual task result';
  const voiceTurnId = 'item-e2e-qwen-voice-turn-001';
  await ctx.alphaPage!.evaluate(({ transcript, turnId }) => {
    const view = window as unknown as { __dotsQwenEventChannel: { emit(event: unknown): void } };
    view.__dotsQwenEventChannel.emit({ type: 'input_audio_buffer.speech_started', item_id: turnId });
    const completed = { type: 'conversation.item.input_audio_transcription.completed', event_id: 'event-e2e-qwen-voice-turn-001', item_id: turnId, transcript };
    view.__dotsQwenEventChannel.emit(completed);
    view.__dotsQwenEventChannel.emit(completed);
    view.__dotsQwenEventChannel.emit({ type: 'response.created', response: { id: 'dispatch-first', modalities: ['text', 'audio'] } });
    const tool = { type: 'function_call', call_id: 'call-first', name: 'delegate_task', arguments: JSON.stringify({ instruction: transcript }) };
    view.__dotsQwenEventChannel.emit({ type: 'response.output_item.done', response_id: 'dispatch-first', item: tool });
    view.__dotsQwenEventChannel.emit({ type: 'response.output_item.done', response_id: 'dispatch-first', item: tool });
    window.setTimeout(() => view.__dotsQwenEventChannel.emit({ type: 'response.done', response: { id: 'dispatch-first', status: 'completed', output: [tool] } }), 700);
  }, { transcript: voiceTurnTranscript, turnId: voiceTurnId });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="voice-call-transcript"]')?.getAttribute('data-task-status')?.includes('已完成') === true, null, { timeout: 20_000 });
  await ctx.alphaPage!.waitForFunction(() => (window as unknown as { __dotsQwenSentEvents?: { type: string; item?: { content?: { text?: string }[] } }[] }).__dotsQwenSentEvents?.some(event => event.type === 'conversation.item.create' && event.item?.content?.some(part => part.text?.includes('Voice response returned from the model.'))) === true, null, { timeout: 10_000 });
  const spokenResponses = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenSentEvents: { type: string; response?: { modalities?: string[] } }[] }).__dotsQwenSentEvents.filter(event => event.type === 'response.create'));
  assert.equal(spokenResponses.length, 3, 'Greeting, acceptance, and actual task result must be separate responses');
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
    const channel = (window as unknown as QwenInterruptionWindow).__dotsQwenEventChannel;
    const transcript = 'E2E voice long response — summarize actual task result';
    channel.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-e2e-qwen-long-002' });
    channel.emit({ type: 'response.created', response: { id: 'dispatch-long', modalities: ['text', 'audio'] } });
    channel.emit({ type: 'response.done', response: { id: 'dispatch-long', status: 'completed', output: [{ type: 'function_call', call_id: 'call-long', name: 'delegate_task', arguments: JSON.stringify({ instruction: transcript }) }] } });
    // Transcription and tool events can arrive in either order.
    channel.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-e2e-qwen-long-002', transcript });
  });
  await ctx.alphaPage!.waitForFunction(summary => (window as unknown as { __dotsQwenSentEvents?: { type: string; item?: { content?: { text?: string }[] } }[] }).__dotsQwenSentEvents?.some(event => event.type === 'conversation.item.create' && event.item?.content?.some(part => part.text?.includes(summary))) === true, qwenLongVoiceSummary, { timeout: 20_000 });
  const longResult = await ctx.alphaPage!.evaluate(async () => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { instruction: string; result: string }[] };
    return state.tasks.find(task => task.instruction === 'E2E voice long response — summarize actual task result')?.result;
  });
  assert.equal(longResult, qwenLongVoiceResult, 'The full result must remain in chat data while only the summary is spoken');
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenSentEvents: { type: string }[] }).__dotsQwenSentEvents.filter(event => event.type === 'response.create').length), 5);
  await qwenSecretaryTools(ctx, turnResult.callId, turnResult.task.id);
  await qwenInterruption(ctx, model);
  await qwenRecovery(ctx, turnResult.callId);
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenExtraStreams: number }).__dotsQwenExtraStreams), 0, 'Voice results must reuse the chat snapshot without opening any additional SSE connections');
  await ctx.screenshot(ctx.alphaPage!, 'qwen-realtime-call-agent-result');
  await call.getByRole('button', { name: '结束通话' }).click();
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsQwenFakeTrack: { stopped: boolean } }).__dotsQwenFakeTrack.stopped), true, 'Ending the call must stop the microphone track');
  const callHistory = await ctx.alphaPage!.evaluate(async () => await fetch('/api/voice-calls').then(response => response.json())) as { endedAt: string | null }[];
  assert(callHistory.some(item => item.endedAt), 'The Qwen call should be durably recorded when it ends');
  assert.equal(await ctx.alphaPage!.evaluate(async ({ callId, taskId }) => (await fetch(`/api/voice-calls/${callId}/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }) })).status, { callId: turnResult.callId, taskId: turnResult.task.id }), 404, 'Ended calls cannot start new speech preparation');

  // Input can arrive while replaceTrack/model setup is still resolving. A late
  // setup acknowledgement must never insert the greeting into that user turn.
  const startupUpdates = await ctx.alphaPage!.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.filter(event => event.type === 'session.update').length);
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByTestId('profile-voice-call-launch').click();
  await ctx.alphaPage!.waitForFunction(count => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.filter(event => event.type === 'session.update').length > count, startupUpdates);
  const startupResponses = await ctx.alphaPage!.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudioResponses.length);
  await ctx.alphaPage!.evaluate(() => {
    const view = window as unknown as QwenInterruptionWindow & { __dotsQwenConfirmSession: () => void };
    view.__dotsQwenEventChannel.emit({ type: 'input_audio_buffer.speech_started', item_id: 'early-startup-input' });
    view.__dotsQwenConfirmSession();
  });
  await ctx.alphaPage!.waitForFunction(() => (window as unknown as { __dotsQwenFakeSender: { track: unknown } }).__dotsQwenFakeSender.track !== null);
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudioResponses.length), startupResponses, 'Speaking during startup must suppress the late greeting');
  await ctx.alphaPage!.getByTestId('voice-call').getByRole('button', { name: '结束通话' }).click();
  await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsRestoreEventSource: () => void }).__dotsRestoreEventSource());

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
  await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsRestoreTimeout: () => void }).__dotsRestoreTimeout());
}

interface QwenInterruptionWindow extends Window {
  __dotsQwenEventChannel: { emit(event: unknown): void };
  __dotsQwenSentEvents: { type: string; item?: { content?: { text?: string }[] } }[];
  __dotsQwenAudioResponses: { id: string; modalities: string[] }[];
  __dotsQwenAudio: { muted: boolean };
  __dotsQwenHoldAudioCreated: boolean;
  __dotsQwenHoldAudioDone: boolean;
}

async function qwenSecretaryTools(ctx: UiScenarioContext, callId: string, taskId: string) {
  const page = ctx.alphaPage!;
  const scoped = await ctx.betaPage!.evaluate(async ({ callId, taskId }) => ({
    status: (await fetch(`/api/voice-calls/${callId}/tasks/${taskId}`)).status,
    message: (await fetch(`/api/voice-calls/${callId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId: 'foreign', role: 'assistant', text: 'forged' }) })).status,
  }), { callId, taskId });
  assert.deepEqual(scoped, { status: 404, message: 404 });
  const tool = (id: string, name: string, args: unknown, text: string) => page.evaluate(({ id, name, args, text }) => {
    const channel = (window as unknown as QwenInterruptionWindow).__dotsQwenEventChannel;
    channel.emit({ type: 'input_audio_buffer.speech_started', item_id: id });
    channel.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
    channel.emit({ type: 'response.created', response: { id: 'response-' + id, modalities: ['text', 'audio'] } });
    channel.emit({ type: 'response.done', response: { id: 'response-' + id, status: 'completed', output: [{ type: 'function_call', call_id: 'call-' + id, name, arguments: JSON.stringify(args) }] } });
  }, { id, name, args, text });
  const output = async (id: string) => {
    await page.waitForFunction(id => (window as unknown as { __dotsQwenSentEvents: { item?: { call_id?: string } }[] }).__dotsQwenSentEvents.some(e => e.item?.call_id === 'call-' + id), id);
    return await page.evaluate(id => JSON.parse((window as unknown as { __dotsQwenSentEvents: { item?: { call_id?: string; output?: string } }[] }).__dotsQwenSentEvents.find(e => e.item?.call_id === 'call-' + id)!.item!.output!), id) as { task_id?: string; status?: string; result?: string; message?: string; total?: number; files?: { path: string; download_url: string }[]; error?: string };
  };
  const count = () => page.evaluate(async () => (await fetch('/api/state').then(r => r.json())).tasks.length as number);
  const beforeStatus = await count();
  await tool('status-query', 'get_task_status', { task_id: taskId }, '刚才的任务做完了吗？');
  assert.equal((await output('status-query')).status, 'done');
  assert.equal(await count(), beforeStatus, 'A progress question must read the existing task, not create another');
  await tool('empty-files', 'get_task_files', {}, '我想下载这个文件。');
  const emptyFiles = await output('empty-files');
  assert.equal(emptyFiles.total, 0);
  assert.deepEqual(emptyFiles.files, []);
  assert.match(emptyFiles.message!, /暂未找到/);
  const fileRoute = `**/api/tasks/${taskId}/artifacts`;
  await page.route(fileRoute, route => route.fulfill({ json: { artifacts: [{ path: '导出/汇总 #1.csv', name: '汇总 #1.csv', size: 12, mediaType: 'text/csv', previewable: false }] } }));
  try {
    await tool('download-files', 'get_task_files', { task_id: taskId }, '应该看哪个汇总文件？');
    const files = await output('download-files');
    assert.equal(files.task_id, taskId);
    assert.equal(files.total, 1);
    assert.equal(files.files?.[0].download_url, `/api/tasks/${taskId}/artifacts/file/%E5%AF%BC%E5%87%BA/%E6%B1%87%E6%80%BB%20%231.csv`);
    await page.waitForURL(`**/chat/${taskId}`);
    assert.equal(await page.getByTestId('voice-call').count(), 1, 'Opening task files keeps the compact call connected');
    assert.equal(await count(), beforeStatus, 'File retrieval must not rerun the original task');
    await page.route(fileRoute, route => route.fulfill({ status: 503, json: { error: '文件服务暂不可用' } }));
    await tool('failed-files', 'get_task_files', { task_id: taskId }, '再给我文件。');
    assert.match((await output('failed-files')).error!, /文件服务暂不可用/);
  } finally { await page.unroute(fileRoute); }
  const otherTask = await page.evaluate(async callId => {
    const state = await fetch('/api/state').then(r => r.json());
    for (const task of state.tasks) {
      if ((await fetch(`/api/voice-calls/${callId}/tasks/${task.id}`)).status === 404) return task.id as string;
    }
    throw new Error('Expected an existing task outside this voice call');
  }, callId);
  await tool('foreign-call-files', 'get_task_files', { task_id: otherTask }, '下载另一个通话的文件。');
  assert.match((await output('foreign-call-files')).error!, /本次通话没有该任务/);
  assert.equal(await count(), beforeStatus);
  await tool('clarification-task', 'delegate_task', { instruction: '请用云电脑打开网页并告诉我标题。' }, '请用云电脑打开网页并告诉我标题。');
  const waitingId = (await output('clarification-task')).task_id!;
  await page.waitForFunction(async id => (await fetch('/api/state').then(r => r.json())).tasks.find((t: { id: string }) => t.id === id)?.status === 'waiting', waitingId);
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-call-transcript"]')?.getAttribute('data-task-status') === '等待你的回复');
  const beforeReply = await count();
  await tool('clarification-reply', 'delegate_task', { task_id: waitingId, instruction: '请打开 https://example.com/。' }, '请打开 https://example.com/。');
  assert.equal((await output('clarification-reply')).task_id, waitingId);
  await page.waitForFunction(async id => (await fetch('/api/state').then(r => r.json())).tasks.find((t: { id: string }) => t.id === id)?.status === 'done', waitingId);
  assert.equal(await count(), beforeReply, 'A spoken clarification must resume the same task');
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
    { type: 'response.created', response: { id: `native-${name}`, modalities: ['text', 'audio'] } },
    { type: 'response.output_item.done', response_id: `native-${name}`, item: { type: 'function_call', call_id: `call-${name}`, name: 'delegate_task', arguments: JSON.stringify({ instruction: instruction(name) }) } },
    ...(finishResponse ? [{ type: 'response.done', response: { id: `native-${name}`, status: 'completed' } }] : []),
  ]);
  const input = async (name: string, finishResponse = true) => { await start(name); await complete(name, finishResponse); };
  const waitDone = (name: string) => page.waitForFunction(async instruction => {
    const state = await fetch('/api/state').then(r => r.json());
    return state.tasks.some((t: { instruction: string; status: string }) => t.instruction === instruction && t.status === 'done');
  }, instruction(name));
  const waitResult = (name: string) => page.waitForFunction(name => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.some(e => e.item?.content?.some(p => p.text?.includes(`Voice interruption result: ${name}.`))), name);
  const waitReceipt = (name: string) => page.waitForFunction(name => (window as unknown as { __dotsQwenSentEvents: { item?: { call_id?: string } }[] }).__dotsQwenSentEvents.some(e => e.item?.call_id === `call-${name}`), name);

  let releaseCached!: () => void;
  const cachedGate = new Promise<void>(resolve => { releaseCached = resolve; });
  const routePattern = '**/api/voice-calls/*/turns';
  await page.route(routePattern, async route => {
    if (route.request().postDataJSON().turnId !== 'cached-result') { await route.continue(); return; }
    const response = await route.fetch(); await cachedGate; await route.fulfill({ response });
  });
  try {
    await input('cached-result'); await waitDone('cached-result'); releaseCached(); await waitResult('cached-result');
  } finally { releaseCached(); await page.unroute(routePattern); }

  // Interrupt an incomplete tool response: it must not create work at all.
  await input('queued', false); await start('after-queue'); await start('after-queue');
  await emit([{ type: 'response.done', response: { id: 'native-queued', status: 'cancelled' } }]);
  await complete('after-queue'); await waitResult('after-queue');
  assert(!ctx.mockModelPrompts.some(prompt => prompt.includes(instruction('queued'))));

  await input('late-task'); await ctx.waitFor(() => qwenInterruptionReleases.has('late-task'), 10_000); await waitReceipt('late-task');
  await start('after-task'); qwenInterruptionReleases.get('late-task')!(); await waitDone('late-task');
  assert.equal(await page.getByTestId('voice-call-transcript').getAttribute('data-task-status'), '');
  await complete('after-task'); await waitResult('after-task');

  let releaseAcceptance!: () => void;
  const acceptanceGate = new Promise<void>(resolve => { releaseAcceptance = resolve; });
  let acceptanceHeld = false;
  await page.route(routePattern, async route => {
    if (route.request().postDataJSON().turnId !== 'late-acceptance') { await route.continue(); return; }
    const response = await route.fetch(); acceptanceHeld = true; await acceptanceGate; await route.fulfill({ response });
  });
  try {
    await input('late-acceptance'); await ctx.waitFor(() => acceptanceHeld, 10_000);
    await start('after-acceptance'); await complete('after-acceptance'); await waitResult('after-acceptance');
    releaseAcceptance(); await waitDone('late-acceptance');
  } finally { releaseAcceptance(); await page.unroute(routePattern); }

  let releaseSummary!: () => void;
  const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
  let summaryHeld = false;
  const speechRoute = '**/api/voice-calls/*/speech';
  await page.route(speechRoute, async route => {
    const response = await route.fetch(); summaryHeld = true; await summaryGate;
    try { await route.fulfill({ response }); } catch { /* Superseded preparation is aborted. */ }
  });
  try {
    await input('summary'); await ctx.waitFor(() => summaryHeld, 10_000);
    await start('after-summary'); releaseSummary(); await complete('after-summary'); await waitResult('after-summary');
  } finally { releaseSummary(); await page.unroute(speechRoute); }

  // Native dialogue audio supports the same immediate barge-in as task speech.
  await start('playing');
  await emit([{ type: 'response.created', response: { id: 'native-playing', modalities: ['text', 'audio'] } }]);
  assert.equal(await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudio.muted), false);
  await start('after-playing');
  assert.equal(await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudio.muted), true);
  await call.getByRole('button', { name: '关闭扬声器' }).click(); await call.getByRole('button', { name: '打开扬声器' }).click();
  assert.equal(await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudio.muted), true);
  await complete('after-playing', false);
  const cancellation = { type: 'response.done', response: { id: 'native-playing', status: 'cancelled' } };
  await emit([cancellation, cancellation, { type: 'response.done', response: { id: 'native-after-playing', status: 'completed' } }]);
  await waitResult('after-playing');

  await page.evaluate(() => { const w = window as unknown as QwenInterruptionWindow; w.__dotsQwenHoldAudioCreated = true; w.__dotsQwenHoldAudioDone = true; });
  await input('late-created'); await waitReceipt('late-created');
  const late = await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudioResponses.at(-1)!);
  await start('after-created'); await emit([{ type: 'response.created', response: late }]);
  assert.equal(await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenAudio.muted), true);
  await emit([{ type: 'response.done', response: { id: late.id, status: 'cancelled' } }]);
  await page.evaluate(() => { const w = window as unknown as QwenInterruptionWindow; w.__dotsQwenHoldAudioCreated = false; w.__dotsQwenHoldAudioDone = false; });
  await complete('after-created'); await waitResult('after-created');
  const texts = await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.flatMap(e => e.item?.content?.map(p => p.text || '') || []));
  for (const obsolete of ['queued', 'late-task', 'late-acceptance']) assert(!texts.some(text => text.includes(`Voice interruption result: ${obsolete}.`)), `Obsolete ${obsolete} result must not be spoken`);
  assert.equal(texts.filter(text => text.includes(qwenLongVoiceSummary)).length, 1);
}


async function qwenRecovery(ctx: UiScenarioContext, callId: string) {
  const page = ctx.alphaPage!;
  const before = await page.evaluate(async () => ({ calls: (await fetch('/api/voice-calls').then(r => r.json())).length, tasks: (await fetch('/api/state').then(r => r.json())).tasks.length }));
  await page.evaluate(() => {
    const w = window as unknown as QwenInterruptionWindow;
    w.__dotsQwenEventChannel.emit({ type: 'input_audio_buffer.speech_started', item_id: 'recovery-input' });
    w.__dotsQwenEventChannel.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'recovery-input', transcript: 'E2E voice interruption reconnect-wait' });
    w.__dotsQwenEventChannel.emit({ type: 'response.created', response: { id: 'recovery-task' } });
    w.__dotsQwenEventChannel.emit({ type: 'response.done', response: { id: 'recovery-task', status: 'completed', output: [{ type: 'function_call', call_id: 'recovery-tool', name: 'delegate_task', arguments: JSON.stringify({ instruction: 'E2E voice interruption reconnect-wait' }) }] } });
  });
  await ctx.waitFor(() => qwenInterruptionReleases.has('reconnect-wait'), 10_000);
  await page.getByTestId('voice-call').getByRole('button', { name: '静音' }).click();
  const peersBefore = await page.evaluate(() => {
    const w = window as unknown as { __dotsQwenPeers: { connectionState: string; onconnectionstatechange: () => void }[] };
    const peer = w.__dotsQwenPeers.at(-1)!; peer.connectionState = 'failed'; peer.onconnectionstatechange(); peer.onconnectionstatechange();
    return w.__dotsQwenPeers.length;
  });
  qwenInterruptionReleases.get('reconnect-wait')!();
  await page.waitForFunction(async () => (await fetch('/api/state').then(r => r.json())).tasks.some((t: { instruction: string; status: string }) => t.instruction === 'E2E voice interruption reconnect-wait' && t.status === 'done'));
  await page.waitForFunction(count => (window as unknown as { __dotsQwenPeers: unknown[] }).__dotsQwenPeers.length > count, peersBefore);
  await page.waitForFunction(() => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.at(-1)?.type === 'session.update');
  assert.equal(await page.evaluate(() => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.some(event => event.item?.content?.some(part => part.text?.includes('Voice interruption result: reconnect-wait.')))), false, 'No speech is sent before the replacement provider is ready');
  await page.evaluate(() => (window as unknown as { __dotsQwenConfirmSession: () => void }).__dotsQwenConfirmSession());
  await page.waitForFunction(() => (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.some(event => event.item?.content?.some(part => part.text?.includes('Voice interruption result: reconnect-wait.'))));
  const after = await page.evaluate(async id => ({
    calls: await fetch('/api/voice-calls').then(r => r.json()), tasks: (await fetch('/api/state').then(r => r.json())).tasks.length,
    muted: !(window as unknown as { __dotsQwenFakeTrack: { enabled: boolean } }).__dotsQwenFakeTrack.enabled,
    resultRequests: (window as unknown as QwenInterruptionWindow).__dotsQwenSentEvents.filter(e => e.item?.content?.some(p => p.text?.includes('结果播报请求') && p.text.includes('Voice interruption result: reconnect-wait.'))).length,
    id,
  }), callId);
  assert.equal(after.calls.length, before.calls); assert(after.calls.some((call: { id: string; endedAt: string | null }) => call.id === callId && !call.endedAt));
  assert.equal(after.tasks, before.tasks + 1); assert.equal(after.muted, true); assert.equal(after.resultRequests, 1);
}
