import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function volcanoRealtime(ctx: UiScenarioContext) {
  ctx.mockVolcEngineUrl = await ctx.startMockVolcEngineProvider();
  await ctx.stopServer(ctx.server);
  ctx.server = await ctx.startServer(ctx.e2ePort, { DOTS_VOICE_PROVIDER: 'volcengine' });
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByTestId('profile-voice-call-launch').click();
  const unconfiguredCall = ctx.alphaPage!.getByTestId('voice-call');
  await unconfiguredCall.getByRole('alert').filter({ hasText: 'SeedDuplex 实时语音 API Key' }).waitFor({ state: 'visible' });
  await unconfiguredCall.getByRole('button', { name: '结束通话' }).click();

  await ctx.stopServer(ctx.server);
  ctx.server = await ctx.startServer(ctx.e2ePort, {
    DOTS_VOICE_PROVIDER: 'volcengine',
    DOTS_VOLCENGINE_APP_ID: 'e2e-volc-app-id',
    DOTS_VOLCENGINE_ACCESS_TOKEN: 'e2e-volc-access-token',
    DOTS_VOLCENGINE_RESOURCE_ID: 'volc.speech.dialog',
    DOTS_E2E_VOLCENGINE_WS_URL: ctx.mockVolcEngineUrl,
  });
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await ctx.alphaContext!.grantPermissions(['microphone'], { origin: ctx.baseUrl });
  await ctx.alphaPage!.evaluate(`(() => {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      Object.defineProperty(window, '__dotsVolcTrack', { configurable: true, value: null, writable: true });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async constraints => {
        const stream = await getUserMedia(constraints);
        window.__dotsVolcTrack = stream.getAudioTracks()[0] || null;
        return stream;
      } } });
    })()`);
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByTestId('profile-voice-call-launch').click();
  const call = ctx.alphaPage!.getByTestId('voice-call');
  await call.waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="voice-call"]')?.getAttribute('data-voice-provider') === 'volcengine');
  await call.locator('[data-testid="voice-call-transcript"]').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="voice-call-transcript"]')?.textContent?.includes('正在聆听') === true, null, { timeout: 20_000 });
  assert.equal(ctx.mockVolcEngineConnections.length, 1, 'The authenticated call should establish exactly one provider socket');
  const providerConnection = ctx.mockVolcEngineConnections[0];
  assert.equal(providerConnection.headers['x-api-app-id'], 'e2e-volc-app-id');
  assert.equal(providerConnection.headers['x-api-access-key'], 'e2e-volc-access-token');
  assert.equal(providerConnection.headers['x-api-resource-id'], 'volc.speech.dialog');
  assert.equal(providerConnection.headers['x-api-app-key'], 'PlgvMymc7f3tQnJ6');
  const publicProviderInfo = await ctx.alphaPage!.evaluate(async () => await fetch('/api/voice/provider').then(response => response.json())) as Record<string, unknown>;
  assert.deepEqual(publicProviderInfo, { provider: 'volcengine', configured: true, model: 'doubao-realtime-dialogue-2.0' }, 'Public provider state must not contain Volcano credentials');
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="voice-call-transcript"]')?.getAttribute('data-task-status')?.includes('已完成') === true, null, { timeout: 30_000 });
  assert(providerConnection.pcmBytes >= 640, 'The browser must stream 16 kHz PCM packets to the gateway');
  assert(providerConnection.events.includes(100) && providerConnection.events.includes(200), 'Provider must see StartSession followed by audio TaskRequest frames');
  assert(providerConnection.spokenTexts.some(text => text.includes('已完成：本周公开资料中有三项值得关注')), 'The Chinese Agent result must be spoken through the provider TTS channel');
  assert(ctx.mockModelPrompts.some(prompt => prompt.includes('请用中文整理本周人工智能产品更新的三个要点，并说明来源。')), 'Finalized Chinese Volcano ASR text must start a normal tenant Agent task');

  const activeCall = await ctx.alphaPage!.evaluate(async () => (await fetch('/api/voice-calls').then(response => response.json()) as { id: string; endedAt: string | null }[]).find(item => !item.endedAt) || null);
  assert(activeCall, 'The realtime call must have a user-owned call record');
  const betaCookie = (await ctx.betaContext!.cookies(ctx.baseUrl)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const crossTenantUpgrade = await ctx.websocketUpgradeStatus(`${ctx.baseUrl.replace(/^http/, 'ws')}/api/voice-calls/${activeCall.id}/volcengine-stream`, betaCookie);
  assert.equal(crossTenantUpgrade, 404, 'A different tenant cannot open another account’s voice stream');
  await call.getByRole('button', { name: '静音' }).click();
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsVolcTrack: MediaStreamTrack }).__dotsVolcTrack.enabled), false, 'Mute must disable the captured microphone track');
  await call.getByRole('button', { name: '取消静音' }).click();
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsVolcTrack: MediaStreamTrack }).__dotsVolcTrack.enabled), true, 'Unmute must resume microphone capture');
  await ctx.screenshot(ctx.alphaPage!, 'volcengine-realtime-call-agent-result');
  await call.getByRole('button', { name: '结束通话' }).click();
  await call.waitFor({ state: 'detached' });
  assert.equal(await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsVolcTrack: MediaStreamTrack }).__dotsVolcTrack.readyState), 'ended', 'Ending a call must release the microphone');
  await ctx.waitFor(() => {
    const finishSession = providerConnection.timeline.indexOf('client:102');
    const sessionFinished = providerConnection.timeline.indexOf('server:152');
    const finishConnection = providerConnection.timeline.indexOf('client:2');
    return finishSession >= 0 && sessionFinished > finishSession && finishConnection > sessionFinished;
  }, 5_000).catch(() => undefined);
  const finishSession = providerConnection.timeline.indexOf('client:102');
  const sessionFinished = providerConnection.timeline.indexOf('server:152');
  const finishConnection = providerConnection.timeline.indexOf('client:2');
  assert(finishSession >= 0 && sessionFinished > finishSession && finishConnection > sessionFinished, `Call cleanup must await session closure before finishing the provider connection; received ${providerConnection.timeline.join(', ')}`);
}

export async function seedDuplexEntitlement(ctx: UiScenarioContext) {
  const rejectedUrl = await ctx.startMockVolcEngineEntitlementRejection();
  await ctx.stopServer(ctx.server);
  ctx.server = await ctx.startServer(ctx.e2ePort, {
    DOTS_VOICE_PROVIDER: 'volcengine',
    DOTS_VOLCENGINE_API_KEY: 'e2e-seedduplex-secret',
    DOTS_E2E_VOLCENGINE_DUPLEX_WS_URL: rejectedUrl,
  });
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByTestId('profile-voice-call-launch').click();
  const call = ctx.alphaPage!.getByTestId('voice-call');
  await call.waitFor({ state: 'visible' });
  const alert = call.getByRole('alert').filter({ hasText: '端到端实时语音尚未开通' });
  await alert.waitFor({ state: 'visible', timeout: 15_000 });
  const visibleError = await alert.textContent();
  assert.equal(visibleError?.includes('requested resource not granted'), false, 'Raw provider response text must not reach the browser');
  assert.equal(visibleError?.includes('volc.speech.dialog'), false, 'Provider resource diagnostics must stay server-side');
  await ctx.screenshot(ctx.alphaPage!, 'volcengine-resource-not-enabled');
  await ctx.alphaPage!.waitForFunction(async () => {
    const calls = await fetch('/api/voice-calls').then(response => response.json()) as { endedAt: string | null }[];
    return Boolean(calls[0]?.endedAt);
  }, null, { timeout: 10_000 });
  await call.getByRole('button', { name: '结束通话' }).click();
  await call.waitFor({ state: 'detached' });
  if (ctx.mockVolcEngineRejectedServer) {
    await new Promise<void>((resolvePromise, reject) => ctx.mockVolcEngineRejectedServer!.close(error => error ? reject(error) : resolvePromise()));
    ctx.mockVolcEngineRejectedServer = null;
  }
}

export async function mobileSeedDuplex(ctx: UiScenarioContext) {
  ctx.mockVolcEngineDuplexUrl = await ctx.startMockVolcEngineDuplexProvider();
  await ctx.stopServer(ctx.server);
  ctx.server = await ctx.startServer(ctx.e2ePort, {
    DOTS_VOICE_PROVIDER: 'volcengine',
    DOTS_VOLCENGINE_API_KEY: 'e2e-seedduplex-secret',
    DOTS_E2E_VOLCENGINE_DUPLEX_WS_URL: ctx.mockVolcEngineDuplexUrl,
  });
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await ctx.mobilePage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.mobilePage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.mobilePage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await ctx.mobileContext!.grantPermissions(['microphone'], { origin: ctx.baseUrl });
  assert.deepEqual(await ctx.mobilePage!.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    touch: navigator.maxTouchPoints > 0,
    mobileLayout: window.matchMedia('(max-width: 520px)').matches,
  })), { width: 390, height: 844, touch: true, mobileLayout: true }, 'The live voice-provider test must run in a touch-enabled 390×844 mobile Chrome context');
  await ctx.mobilePage!.evaluate(`(() => {
      const originalStart = AudioBufferSourceNode.prototype.start;
      window.__dotsVolcPlaybackCapture = [];
      AudioBufferSourceNode.prototype.start = function(...args) {
        const buffer = this.buffer;
        if (buffer && buffer.sampleRate === 24000) {
          const data = buffer.getChannelData(0);
          let peak = 0;
          for (let index = 0; index < data.length; index += 1) peak = Math.max(peak, Math.abs(data[index]));
          window.__dotsVolcPlaybackCapture.push({ sampleRate: buffer.sampleRate, length: data.length, peak });
        }
        return originalStart.apply(this, args);
      };
    })()`);
  await ctx.mobilePage!.evaluate(`(() => {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      Object.defineProperty(window, '__dotsVolcDuplexTrack', { configurable: true, value: null, writable: true });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async constraints => {
        const stream = await getUserMedia(constraints);
        window.__dotsVolcDuplexTrack = stream.getAudioTracks()[0] || null;
        return stream;
      } } });
    })()`);
  assert.equal(await ctx.mobilePage!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'The signed-in mobile Dot conversation must fit the phone viewport before starting a call');
  const mobileDotNav = ctx.mobilePage!.getByTestId('mobile-dot-nav');
  if (await mobileDotNav.isVisible()) await mobileDotNav.click();
  await ctx.mobilePage!.getByTestId('conversation-call-launch').click();
  const call = ctx.mobilePage!.getByTestId('voice-call');
  await call.waitFor({ state: 'visible' });
  assert.equal(await call.getAttribute('data-variant'), 'mobile', 'The live SeedDuplex call must use the mobile phone surface');
  const mobileCallBounds = await call.boundingBox();
  assert(mobileCallBounds && mobileCallBounds.x === 0 && mobileCallBounds.y === 0 && mobileCallBounds.width === 390 && mobileCallBounds.height === 844, 'The live mobile call surface must fill the phone viewport');
  await ctx.mobilePage!.waitForFunction(() => {
    const dialog = document.querySelector('[data-testid="voice-call"]');
    return dialog?.getAttribute('data-voice-provider') === 'volcengine' && dialog.getAttribute('data-voice-model') === 'doubao-seedduplex-3.0';
  });
  await ctx.mobilePage!.waitForFunction(() => {
    const state = document.querySelector('[data-testid="voice-call"]')?.getAttribute('data-voice-mic-state');
    return state === 'sent' || state === 'no-frames' || state === 'context-suspended';
  }, null, { timeout: 20_000 });
  assert.equal(await call.getAttribute('data-voice-mic-state'), 'sent', 'The browser must start microphone PCM capture after SeedDuplex connects');
  assert(await ctx.mobilePage!.getByTestId('voice-call-transcript').textContent().then(text => text?.includes('正在聆听')), 'The mobile call should report listening only after microphone PCM frames have been sent');
  await ctx.mobilePage!.waitForFunction(() => Number(document.querySelector('[data-testid="voice-call"]')?.getAttribute('data-voice-mic-level')) > 0, null, { timeout: 10_000 });
  assert(Number(await call.getAttribute('data-voice-mic-level')) > 0, 'The mobile call must detect a non-silent microphone signal even though its compact phone UI omits the desktop meter');
  assert.equal(ctx.mockVolcEngineDuplexConnections.length, 1, 'The authenticated SeedDuplex call should open one provider connection');
  const providerConnection = ctx.mockVolcEngineDuplexConnections[0];
  assert.equal(providerConnection.headers['x-api-key'], 'e2e-seedduplex-secret', 'The shared API key must be sent only from the server');
  assert(providerConnection.headers['x-api-request-id'], 'Each provider connection must carry a traceable request ID');
  const publicProviderInfo = await ctx.mobilePage!.evaluate(async () => await fetch('/api/voice/provider').then(response => response.json())) as Record<string, unknown>;
  assert.deepEqual(publicProviderInfo, { provider: 'volcengine', configured: true, model: 'doubao-seedduplex-3.0' }, 'Public provider state must not reveal the API key');
  await ctx.mobilePage!.waitForFunction(() => document.querySelector('[data-testid="voice-call-transcript"]')?.getAttribute('data-task-status')?.includes('已完成') === true, null, { timeout: 30_000 });
  await ctx.waitFor(() => providerConnection.audioDeltas > 0, 5_000);
  const playbackFrames = await ctx.mobilePage!.evaluate(() => (window as unknown as { __dotsVolcPlaybackCapture: { sampleRate: number; length: number; peak: number }[] }).__dotsVolcPlaybackCapture);
  assert(playbackFrames.some(frame => frame.sampleRate === 24_000 && frame.length === 240 && frame.peak >= 0.45), 'The browser must decode and schedule SeedDuplex float32 output at 24 kHz instead of dropping it or playing static');
  assert(providerConnection.pcmBytes >= 640, 'The browser must stream 16 kHz PCM audio in realtime-sized packets');
  assert(providerConnection.pcmPeak > 0 && providerConnection.nonSilentPcmSamples > 0, 'SeedDuplex must receive non-silent PCM from the selected microphone, not merely zero-filled frames');
  assert(providerConnection.events.includes('session.create') && providerConnection.events.includes('input_audio_buffer.append'), 'SeedDuplex must use JSON session and audio events');
  assert(providerConnection.spokenTexts.some(text => text.includes('已完成：本周公开资料中有三项值得关注')), 'The Chinese Agent result must be submitted to SeedDuplex direct text-to-speech events');
  assert(providerConnection.events.includes('speech_text_buffer.commit'), 'Agent status speech must use the provider direct-synthesis event');
  assert(ctx.mockModelPrompts.some(prompt => prompt.includes('请用中文整理本周人工智能产品更新的三个要点，并说明来源。')), 'Final Chinese speech transcript from the mobile call must start the normal tenant Agent task');

  const activeCall = await ctx.mobilePage!.evaluate(async () => (await fetch('/api/voice-calls').then(response => response.json()) as { id: string; endedAt: string | null }[]).find(item => !item.endedAt) || null);
  assert(activeCall, 'The SeedDuplex voice session must use the authenticated user-owned call record');
  const betaCookie = (await ctx.betaContext!.cookies(ctx.baseUrl)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const crossTenantUpgrade = await ctx.websocketUpgradeStatus(`${ctx.baseUrl.replace(/^http/, 'ws')}/api/voice-calls/${activeCall.id}/volcengine-stream`, betaCookie);
  assert.equal(crossTenantUpgrade, 404, 'A different tenant cannot open another account’s SeedDuplex stream');
  await call.getByRole('button', { name: '静音' }).click();
  assert.equal(await ctx.mobilePage!.evaluate(() => (window as unknown as { __dotsVolcDuplexTrack: MediaStreamTrack }).__dotsVolcDuplexTrack.enabled), false, 'Mute must disable mobile microphone capture');
  await call.getByRole('button', { name: '取消静音' }).click();
  assert.equal(await ctx.mobilePage!.evaluate(() => (window as unknown as { __dotsVolcDuplexTrack: MediaStreamTrack }).__dotsVolcDuplexTrack.enabled), true, 'Unmute must resume mobile microphone capture');
  await ctx.waitFor(() => providerConnection.events.includes('input_audio_mute.commit') && providerConnection.events.includes('input_audio_unmute.commit'), 5_000);
  await ctx.screenshot(ctx.mobilePage!, 'volcengine-seedduplex-mobile-call-agent-result');
  await call.getByRole('button', { name: '结束通话' }).click();
  await call.waitFor({ state: 'detached' });
  assert.equal(await ctx.mobilePage!.evaluate(() => (window as unknown as { __dotsVolcDuplexTrack: MediaStreamTrack }).__dotsVolcDuplexTrack.readyState), 'ended', 'Ending the mobile call must release the microphone');
  await ctx.waitFor(() => providerConnection.events.includes('session.close') && providerConnection.timeline.includes('server:session.closed'), 5_000);
}

export async function seedDuplexClarification(ctx: UiScenarioContext) {
  const transcript = '请用云电脑打开网页并告诉我标题。';
  const reply = '请打开 https://example.com/。';
  ctx.mockVolcEngineDuplexNextInitialTranscript = transcript;
  const mobileCallButton = ctx.mobilePage!.getByTestId('conversation-call-launch');
  const playbackBefore = await ctx.mobilePage!.evaluate(() => (window as unknown as { __dotsVolcPlaybackCapture: unknown[] }).__dotsVolcPlaybackCapture.length);
  await mobileCallButton.click();
  const call = ctx.mobilePage!.getByTestId('voice-call');
  await call.waitFor({ state: 'visible' });
  await ctx.mobilePage!.waitForFunction(() => document.querySelector('[data-testid="voice-call-transcript"]')?.textContent?.includes('正在聆听') === true, null, { timeout: 20_000 });
  await call.locator('.voice-call-card-transcript').filter({ hasText: transcript }).waitFor({ state: 'visible', timeout: 15_000 });
  await call.locator('.voice-call-card-task').filter({ hasText: '等待你的回复' }).waitFor({ state: 'visible', timeout: 15_000 });

  const waitingState = await ctx.mobilePage!.evaluate(async () => {
    const calls = await fetch('/api/voice-calls').then(response => response.json()) as { id: string; endedAt: string | null }[];
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; instruction: string; status: string; engine: string; result: string | null }[] };
    return { call: calls.find(item => !item.endedAt), task: state.tasks.find(item => item.instruction === '请用云电脑打开网页并告诉我标题。') };
  });
  assert(waitingState.call, 'The spoken clarification must belong to an active account-owned call');
  assert(waitingState.task, 'The spoken request must create one persisted task');
  assert.equal(waitingState.task.status, 'waiting', 'The Agent must request the missing URL instead of claiming success');
  const providerConnection = ctx.mockVolcEngineDuplexConnections.at(-1);
  assert(providerConnection, 'The resumed conversation must use the active SeedDuplex connection');
  await ctx.waitFor(() => providerConnection.spokenTexts.includes('请告诉我你要打开的网址。'), 10_000);

  providerConnection.sendTranscript(reply, 'duplex-e2e-turn-0002');
  providerConnection.sendTranscript(reply, 'duplex-e2e-turn-0002');
  await call.locator('.voice-call-card-transcript').filter({ hasText: reply }).waitFor({ state: 'visible', timeout: 15_000 });
  await call.locator('.voice-call-card-task').filter({ hasText: '已完成：请用云电脑打开网页并告诉我标题' }).waitFor({ state: 'visible', timeout: 20_000 });
  await ctx.waitFor(() => providerConnection.audioDeltas >= 2, 10_000);

  const resumedState = await ctx.mobilePage!.evaluate(async ({ transcriptText, replyText, callId }) => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; instruction: string; status: string; engine: string; result: string | null }[] };
    const calls = await fetch('/api/voice-calls').then(response => response.json()) as { id: string; endedAt: string | null }[];
    const tasks = state.tasks.filter(task => task.instruction.includes(transcriptText));
    const task = tasks[0];
    if (!task) throw new Error('The resumed voice task was not persisted');
    const replay = await fetch(`/api/voice-calls/${callId}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: replyText, turnId: 'duplex-e2e-turn-0002', engine: task.engine }),
    });
    return { tasks, task, call: calls.find(item => item.id === callId), replayStatus: replay.status, replay: await replay.json() as { id?: string } };
  }, { transcriptText: transcript, replyText: reply, callId: waitingState.call.id });
  assert.equal(resumedState.tasks.length, 1, 'A spoken reply must resume the original task instead of creating a second task');
  assert.equal(resumedState.task.status, 'done');
  assert.equal(resumedState.task.result, '网页标题是「Example Domain」。');
  assert(resumedState.task.instruction.includes(`User reply: ${reply}`), 'The resumed task must preserve the spoken URL reply');
  assert.equal(resumedState.replayStatus, 200, 'A duplicate provider turn must return the original task');
  assert.equal(resumedState.replay.id, resumedState.task.id, 'The replay must remain idempotently attached to the original task');
  assert.equal(resumedState.call?.endedAt, null, 'The call must stay open while the resumed Agent answer is spoken');
  assert(providerConnection.spokenTexts.includes('请告诉我你要打开的网址。'), 'The call must speak the Agent clarification');
  assert(providerConnection.spokenTexts.includes('网页标题是「Example Domain」。'), 'The call must speak the completed Agent result');
  const playbackAfter = await ctx.mobilePage!.evaluate(({ initialCount }) => (window as unknown as { __dotsVolcPlaybackCapture: { sampleRate: number; peak: number }[] }).__dotsVolcPlaybackCapture.slice(initialCount), { initialCount: playbackBefore });
  assert(playbackAfter.length >= 2 && playbackAfter.every(frame => frame.sampleRate === 24_000 && frame.peak > 0), 'Both SeedDuplex responses must reach the browser audio playback path');
  await ctx.screenshot(ctx.mobilePage!, 'seedduplex-mobile-multiturn-clarification-resumed');
  await call.getByRole('button', { name: '结束通话' }).click();
  await call.waitFor({ state: 'detached' });
}
