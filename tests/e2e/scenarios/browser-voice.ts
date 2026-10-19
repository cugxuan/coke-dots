import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function desktopVoiceCall(ctx: UiScenarioContext) {
  const voiceMockScript = ctx.browserVoiceMockScript();
  await ctx.alphaPage!.evaluate((script: string) => window.eval(script), voiceMockScript);
  await ctx.openProfile(ctx.alphaPage!);
  const originalDotName = await ctx.alphaPage!.getByLabel('名字').inputValue();
  assert.equal(originalDotName, 'Shared Dot', 'The shared-workspace profile fixture should be explicit before the reference capture');
  await ctx.alphaPage!.getByLabel('名字').fill('dot');
  await ctx.alphaPage!.getByRole('button', { name: '保存更改', exact: true }).click();
  assert.equal(await ctx.alphaPage!.getByLabel('名字').inputValue(), 'dot', 'The profile editor should show the saved Dot name');
  await ctx.alphaPage!.getByRole('button', { name: '拨打 dot', exact: true }).waitFor({ state: 'visible' });
  const desktopViewport = ctx.alphaPage!.viewportSize();
  assert(desktopViewport, 'The desktop call E2E must use a fixed browser viewport');
  const creationRequest = ctx.alphaPage!.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/voice-calls');
  await ctx.alphaPage!.getByTestId('profile-voice-call-launch').click();
  let profileCall = ctx.alphaPage!.getByTestId('voice-call');
  await profileCall.waitFor({ state: 'visible' });
  assert.equal(await profileCall.getAttribute('data-variant'), 'desktop', 'A call launched from the Dot profile on a desktop viewport must use the compact desktop UI');
  assert.equal(await profileCall.locator('.voice-call-screen').count(), 0, 'Desktop profile calls must not render the handset UI');
  const desktopCallBox = await profileCall.boundingBox();
  assert(desktopCallBox && desktopCallBox.width < 350 && desktopCallBox.height < 220,
    'The desktop call must render as a compact floating card');
  assert.equal(await profileCall.locator('.voice-call-card-end').count(), 1, 'The active outgoing call must have exactly one red hang-up action');
  assert.equal(await profileCall.getByRole('button', { name: /接听|回答/ }).count(), 0, 'An active outgoing call must not offer an answer action');
  await ctx.waitFor(async () => {
    const output = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput);
    return output.includes('你好，我是 dot，有什么我可以帮你？');
  }, 10_000);
  await ctx.alphaPage!.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__dotsFakeRecognition));
  const desktopGreetingSequence = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsVoiceEvents: string[] }).__dotsVoiceEvents.slice(0, 2));
  assert.deepEqual(desktopGreetingSequence, ['spoken:你好，我是 dot，有什么我可以帮你？', 'listening'],
    'The call must play a Chinese greeting before opening the browser microphone input');
  const creationBody = (await creationRequest).postDataJSON() as { requestId: string };
  assert.match(creationBody.requestId, /^[a-f0-9-]{36}$/, 'The UI must identify one call attempt across request retries');
  const replayedCalls = await ctx.alphaPage!.evaluate(async body => Promise.all(Array.from({ length: 5 }, async () => {
    const response = await fetch('/api/voice-calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await response.json() as { id: string; startedAt: string; endedAt: string | null; durationSeconds: number | null };
  })), creationBody);
  assert(replayedCalls.every(call => call.id === replayedCalls[0]!.id && call.startedAt === replayedCalls[0]!.startedAt),
    'Concurrent deliveries of one call request must return the same history record');
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-compact-desktop');
  await profileCall.getByRole('button', { name: '结束通话' }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await profileCall.waitFor({ state: 'hidden' });
  const endedReplay = await ctx.alphaPage!.evaluate(async ({ body, id }) => {
    const calls = await (await fetch('/api/voice-calls')).json() as { id: string; endedAt: string; durationSeconds: number }[];
    const ended = calls.find(call => call.id === id);
    const repeated = await (await fetch(`/api/voice-calls/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds: 999 }) })).json();
    const restarted = await (await fetch('/api/voice-calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const invalid = await fetch('/api/voice-calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: '' }) });
    return { ended, repeated, restarted, count: calls.length, invalid: invalid.status };
  }, { body: creationBody, id: replayedCalls[0]!.id });
  assert.deepEqual(endedReplay.repeated, endedReplay.ended, 'Hangup retries must not extend the recorded call');
  assert.deepEqual(endedReplay.restarted, endedReplay.ended, 'Late creation retries must not create another ended-call chip');
  assert.equal(endedReplay.count, 1);
  assert.equal(endedReplay.invalid, 400);

  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  let providerRequested!: () => void;
  const providerStarted = new Promise<void>(resolve => { providerRequested = resolve; });
  await ctx.alphaPage!.route('**/api/voice/provider', async route => { providerRequested(); await providerGate; await route.continue(); });
  await ctx.alphaPage!.getByTestId('voice-call-launch').click();
  await providerStarted;
  await ctx.alphaPage!.getByTestId('voice-call').getByRole('button', { name: '结束通话' }).click();
  await ctx.alphaPage!.getByTestId('voice-call').waitFor({ state: 'hidden' });
  const providerFinished = ctx.alphaPage!.waitForResponse(response => new URL(response.url()).pathname === '/api/voice/provider');
  releaseProvider();
  await (await providerFinished).finished();
  await ctx.alphaPage!.unroute('**/api/voice/provider');
  await ctx.delay(200);
  const afterCancelledStartup = await ctx.alphaPage!.evaluate(async () => (await (await fetch('/api/voice-calls')).json() as unknown[]).length);
  assert.equal(afterCancelledStartup, 1, 'Closing before startup completes must not create a background call record');

  await ctx.alphaPage!.setViewportSize({ width: 690, height: 930 });
  await ctx.openProfile(ctx.alphaPage!);
  const greetingsBefore690 = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput.length);
  await ctx.alphaPage!.getByTestId('profile-voice-call-launch').click();
  profileCall = ctx.alphaPage!.getByTestId('voice-call');
  await profileCall.waitFor({ state: 'visible' });
  const voiceProviderConfig = await ctx.alphaPage!.evaluate(async () => await (await fetch('/api/voice/provider')).json()) as { provider: string; configured: boolean; apiKey?: string };
  assert.deepEqual(voiceProviderConfig, { provider: 'browser', configured: true }, 'The browser fallback must be explicit and must not expose provider credentials');
  const activeCall = await ctx.alphaPage!.evaluate(async () => await fetch('/api/voice-calls').then(response => response.json())) as { id: string; endedAt: string | null }[];
  const activeCallId = activeCall.find(item => !item.endedAt)?.id;
  assert(activeCallId, 'The call UI must create its owner-scoped call record before starting its voice transport');
  const unsupportedRealtimeStatus = await ctx.alphaPage!.evaluate(async (id: string) => (await fetch(`/api/voice-calls/${id}/realtime-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sdp: 'v=0' }) })).status, activeCallId);
  assert.equal(unsupportedRealtimeStatus, 409, 'The browser provider must not be silently treated as a realtime model session');
  const crossTenantRealtimeStatus = await ctx.betaPage!.evaluate(async (id: string) => (await fetch(`/api/voice-calls/${id}/realtime-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sdp: 'v=0' }) })).status, activeCallId);
  assert.equal(crossTenantRealtimeStatus, 404, 'A different tenant cannot negotiate against another user’s active call');
  assert.equal(await profileCall.getAttribute('data-variant'), 'desktop', 'Every browser viewport must use the compact desktop call card');
  const profileCallBox = await profileCall.boundingBox();
  assert(profileCallBox && profileCallBox.width < 350 && profileCallBox.height < 220,
    'The active call must stay a small floating card rather than expanding into a phone screen');
  assert(profileCallBox && profileCallBox.x >= 0 && profileCallBox.y >= 0 && profileCallBox.x + profileCallBox.width <= 690 && profileCallBox.y + profileCallBox.height <= 930,
    'The compact call card must fit the 690×930 browser viewport');
  assert.equal(await profileCall.locator('.voice-call-card-end').count(), 1, 'The outgoing call must have one red hang-up action');
  assert.equal(await profileCall.getByRole('button', { name: /接听|回答/ }).count(), 0, 'An already-connected outgoing call must not show an answer button');
  assert.equal(await profileCall.locator('.voice-call-screen').count(), 0, 'Web calls must never render the mobile handset frame');
  await ctx.waitFor(async () => {
    const output = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput);
    return output.slice(greetingsBefore690).includes('你好，我是 dot，有什么我可以帮你？');
  }, 10_000);
  await ctx.waitFor(async () => {
    const events = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsVoiceEvents: string[] }).__dotsVoiceEvents);
    return events.slice(-2).join('|') === 'spoken:你好，我是 dot，有什么我可以帮你？|listening';
  }, 10_000);
  const greetingSequence = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsVoiceEvents: string[] }).__dotsVoiceEvents.slice(-2));
  assert.deepEqual(greetingSequence, ['spoken:你好，我是 dot，有什么我可以帮你？', 'listening'],
    'The call must play its Chinese greeting before starting browser speech recognition');
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-compact-690');
  await profileCall.screenshot({ path: join(ctx.screenshotsDir, 'voice-call-compact-690.png') });
  ctx.screenshotNames.push('voice-call-compact-690.png');
  await profileCall.getByRole('button', { name: '静音' }).click();
  assert.equal(await profileCall.getByRole('button', { name: '取消静音' }).getAttribute('aria-pressed'), 'true');
  await profileCall.getByRole('button', { name: '取消静音' }).click();
  await profileCall.getByRole('button', { name: '关闭扬声器' }).click();
  assert.equal(await profileCall.getByRole('button', { name: '打开扬声器' }).getAttribute('aria-pressed'), 'false');
  await profileCall.getByRole('button', { name: '打开扬声器' }).click();
  await ctx.delay(1100);
  assert.notEqual(await profileCall.getByTestId('voice-call-timer').innerText(), '0:00');
  await profileCall.getByRole('button', { name: '结束通话' }).click();
  await profileCall.waitFor({ state: 'hidden' });

  await ctx.alphaPage!.setViewportSize({ width: 390, height: 844 });
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByTestId('profile-voice-call-launch').click();
  const narrowCall = ctx.alphaPage!.getByTestId('voice-call');
  await narrowCall.waitFor({ state: 'visible' });
  assert.equal(await narrowCall.getAttribute('data-variant'), 'mobile', 'A narrow mobile Chrome viewport must use the mobile call surface');
  assert.equal(await narrowCall.getByTestId('voice-call-mobile-screen').count(), 1,
    'The mobile call surface must expose the phone-style screen');
  const narrowCallBox = await narrowCall.boundingBox();
  assert(narrowCallBox && narrowCallBox.x === 0 && narrowCallBox.y === 0 && narrowCallBox.width === 390 && narrowCallBox.height === 844,
    'The mobile call surface must fill the 390×844 viewport');
  assert.equal(await narrowCall.locator('.voice-call-mobile-controls button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')).join('|')),
    '关闭扬声器|结束通话|静音', 'Mobile controls must appear in speaker, red hang-up, mute order');
  assert.equal(await narrowCall.locator('.voice-call-card-end').count(), 1);
  assert.equal(await narrowCall.getByRole('button', { name: /接听|回答/ }).count(), 0);
  await ctx.waitFor(async () => {
    const output = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput);
    return output.at(-1) === '你好，我是 dot，有什么我可以帮你？';
  }, 10_000);
  await narrowCall.getByRole('button', { name: '关闭扬声器' }).click();
  assert.equal(await narrowCall.getByRole('button', { name: '打开扬声器' }).getAttribute('aria-pressed'), 'false');
  await narrowCall.getByRole('button', { name: '打开扬声器' }).click();
  await narrowCall.getByRole('button', { name: '静音' }).click();
  assert.equal(await narrowCall.getByRole('button', { name: '取消静音' }).getAttribute('aria-pressed'), 'true');
  await narrowCall.getByRole('button', { name: '取消静音' }).click();
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-mobile-390');
  await narrowCall.screenshot({ path: join(ctx.screenshotsDir, 'voice-call-mobile-390.png') });
  ctx.screenshotNames.push('voice-call-mobile-390.png');
  await narrowCall.getByRole('button', { name: '结束通话' }).click();
  await narrowCall.waitFor({ state: 'hidden' });

  const mobileDotNav = ctx.alphaPage!.getByTestId('mobile-dot-nav');
  if (await mobileDotNav.isVisible()) await mobileDotNav.click();
  await ctx.alphaPage!.locator('.timeline').waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.locator('.shell.dot-chat-mode > .icon-rail').evaluate(element => getComputedStyle(element).display), 'none',
    'The Dot conversation should use the phone header instead of keeping a desktop rail at the bottom');
  assert.equal(await ctx.alphaPage!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The mobile conversation shell must not scroll horizontally');
  const mobileMenuButton = ctx.alphaPage!.getByTestId('mobile-chat-menu-toggle');
  const mobileMenuButtonBox = await mobileMenuButton.boundingBox();
  assert(mobileMenuButtonBox && mobileMenuButtonBox.width >= 44 && mobileMenuButtonBox.height >= 44,
    'The mobile conversation menu must be a touch-sized target');
  assert(await ctx.alphaPage!.getByTestId('mobile-chat-heading').isVisible(),
    'The mobile conversation header must identify the current Dot or task');
  const mobileCallEntry = ctx.alphaPage!.getByTestId('conversation-call-launch');
  assert(await mobileCallEntry.isVisible(), 'The conversation header must offer Call on mobile Chrome');
  const mobileCallEntryBox = await mobileCallEntry.boundingBox();
  assert(mobileCallEntryBox && mobileCallEntryBox.width >= 44 && mobileCallEntryBox.height >= 44,
    'The mobile Call entry must be a touch-sized target');
  await ctx.screenshot(ctx.alphaPage!, 'mobile-chat-dot-timeline-390');
  await mobileMenuButton.click();
  const mobileNavigation = ctx.alphaPage!.getByTestId('mobile-navigation');
  await mobileNavigation.waitFor({ state: 'visible' });
  const mobileNavigationBox = await mobileNavigation.locator('.mobile-navigation-panel').boundingBox();
  assert(mobileNavigationBox && mobileNavigationBox.width <= 320 && mobileNavigationBox.height === 844,
    'The mobile conversation menu should open as a viewport-height side drawer');
  await mobileNavigation.locator('nav').getByRole('button', { name: /Activity/ }).click();
  await ctx.alphaPage!.getByRole('heading', { name: 'Activity', exact: true }).waitFor({ state: 'visible' });
  assert(await mobileDotNav.isVisible(), 'The bottom navigation should remain available on non-chat mobile pages');
  await mobileDotNav.click();
  await ctx.alphaPage!.locator('.timeline').waitFor({ state: 'visible' });
  await ctx.alphaPage!.setViewportSize({ width: 320, height: 640 });
  assert.equal(await ctx.alphaPage!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The Dot conversation must remain free of horizontal overflow on a narrow 320 px phone');
  assert(await ctx.alphaPage!.getByTestId('conversation-call-launch').isVisible(),
    'The Call action must remain reachable on a narrow mobile viewport');
  await ctx.screenshot(ctx.alphaPage!, 'mobile-chat-dot-timeline-320');
  await ctx.alphaPage!.setViewportSize({ width: 390, height: 844 });
  await mobileCallEntry.click();
  const conversationMobileCall = ctx.alphaPage!.getByTestId('voice-call');
  await conversationMobileCall.waitFor({ state: 'visible' });
  assert.equal(await conversationMobileCall.getAttribute('data-variant'), 'mobile');
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-mobile-from-conversation-header');
  await conversationMobileCall.getByRole('button', { name: '结束通话' }).click();
  await conversationMobileCall.waitFor({ state: 'hidden' });
  await ctx.alphaPage!.setViewportSize(desktopViewport);
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByLabel('名字').fill(originalDotName);
  await ctx.alphaPage!.getByRole('button', { name: '保存更改', exact: true }).click();
  assert.equal(await ctx.alphaPage!.getByLabel('名字').inputValue(), originalDotName, 'The Dot profile name should be restored');

  await (await ctx.taskNavigationItem(ctx.alphaPage!, 'E2E shared workspace task')).click();
  const headerCallLaunch = ctx.alphaPage!.getByTestId('conversation-call-launch');
  await headerCallLaunch.waitFor({ state: 'visible' });
  const headerCallBox = await headerCallLaunch.boundingBox();
  const chatContextBox = await ctx.alphaPage!.locator('.dot-context-panel').boundingBox();
  const headerBox = await ctx.alphaPage!.locator('.topbar').boundingBox();
  assert(headerCallBox && chatContextBox && headerBox && headerCallBox.y >= headerBox.y
    && headerCallBox.y + headerCallBox.height <= headerBox.y + headerBox.height
    && headerCallBox.x + headerCallBox.width <= headerBox.x + headerBox.width
    && headerBox.y + headerBox.height <= chatContextBox.y,
    'The conversation call action should stay inside the full-width toolbar above the Dot details panel');
  const headerActionsBox = await ctx.alphaPage!.locator('.top-actions').boundingBox();
  assert(headerCallBox && headerActionsBox && headerCallBox.x >= headerActionsBox.x + headerActionsBox.width,
    'The conversation-header call action should not overlap workspace or theme controls');
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-header-entry-idle');
  await headerCallLaunch.click();
  const headerCall = ctx.alphaPage!.getByTestId('voice-call');
  await headerCall.waitFor({ state: 'visible' });
  assert.equal(await headerCall.getAttribute('data-variant'), 'desktop', 'The conversation-header phone action should enter the desktop call flow');
  assert.equal(await ctx.alphaPage!.locator('.top-actions').evaluate(element => getComputedStyle(element).display), 'none',
    'The compact active call controls should have a clear header row without workspace controls beneath them');
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-header-entry');
  await headerCall.getByRole('button', { name: '结束通话' }).click();
  await headerCall.waitFor({ state: 'hidden' });

  await ctx.alphaPage!.getByTestId('context-call-launch').click();
  const contextCall = ctx.alphaPage!.getByTestId('voice-call');
  await contextCall.waitFor({ state: 'visible' });
  assert.equal(await contextCall.getAttribute('data-variant'), 'desktop', 'The Dot details-panel Call action should use the desktop call flow');
  await contextCall.getByRole('button', { name: '结束通话' }).click();
  await contextCall.waitFor({ state: 'hidden' });

  await ctx.alphaPage!.getByTestId('voice-call-launch').click();
  const recognitionStartsBeforeTaskCall = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsRecognitionStarts: number }).__dotsRecognitionStarts);
  const call = ctx.alphaPage!.getByTestId('voice-call');
  await call.waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction((previousStarts: number) => (window as unknown as { __dotsRecognitionStarts: number }).__dotsRecognitionStarts > previousStarts,
    recognitionStartsBeforeTaskCall);
  assert.equal(await call.getAttribute('data-variant'), 'desktop');
  assert.equal(await call.locator('.voice-call-screen').count(), 0, 'Desktop chat calls should use the compact V2 controls, not the handset surface');
  const inlineBox = await call.boundingBox();
  assert(inlineBox && inlineBox.x > desktopViewport.width * .5 && inlineBox.x + inlineBox.width <= desktopViewport.width && inlineBox.y >= 0,
    'The active call card should float on the right side of the browser without leaving the viewport');
  assert.equal(await call.locator('.voice-call-card-end').count(), 1, 'The card should expose one red hang-up action');
  assert.notEqual(await call.getByRole('button', { name: '静音' }).evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(40, 116, 95)',
    'The microphone control must remain a neutral toggle, not an answer button');
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-active-reference');
  await call.getByRole('button', { name: '静音' }).click();
  assert.equal(await call.getByRole('button', { name: '取消静音' }).getAttribute('aria-pressed'), 'true');
  await call.getByRole('button', { name: '取消静音' }).click();

  let speechOutput = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput);
  const clarification = 'E2E voice clarification — ask which launch date to use';
  const clarificationPromptStart = ctx.mockModelPrompts.length;
  await ctx.alphaPage!.evaluate((text: string) => {
    const pageWindow = window as unknown as { __dotsFakeRecognition?: { emitRepeated: (value: string) => void } };
    pageWindow.__dotsFakeRecognition?.emitRepeated(text);
  }, clarification);
  await ctx.alphaPage!.locator('.timeline .message.user p').filter({ hasText: clarification }).waitFor({ state: 'visible' });
  await ctx.waitFor(async () => {
    const state = await ctx.alphaPage!.evaluate(async () => await (await fetch('/api/state')).json()) as { tasks: { instruction: string }[] };
    return state.tasks.filter(task => task.instruction === clarification).length === 1;
  }, 10_000);
  assert.equal(await ctx.alphaPage!.locator('.timeline .message.user p').filter({ hasText: clarification }).count(), 1,
    'Repeated final-result callbacks for one browser recognition turn must produce one user message');
  await call.getByTestId('voice-call-transcript').waitFor({ state: 'attached' });
  await ctx.waitFor(async () => (await call.getByTestId('voice-call-transcript').getAttribute('data-task-status')) === '等待你的回复', 15_000);
  await ctx.waitFor(async () => {
    speechOutput = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput);
    return speechOutput.includes('What launch date should I use?');
  }, 10_000);
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-waiting-for-clarification');
  const waitingVoiceTask = await ctx.alphaPage!.evaluate(async (text: string) => {
    const snapshot = await (await fetch('/api/state')).json() as { tasks: { id: string; instruction: string; status: string }[] };
    return snapshot.tasks.find(task => task.instruction === text);
  }, clarification);
  assert(waitingVoiceTask, 'The voice question should have one persisted task to resume');
  assert.equal(waitingVoiceTask.status, 'waiting');

  await ctx.alphaPage!.evaluate((text: string) => {
    const pageWindow = window as unknown as { __dotsFakeRecognition?: { emit: (value: string) => void } };
    pageWindow.__dotsFakeRecognition?.emit(text);
  }, 'Use Friday.');
  await ctx.alphaPage!.locator('.timeline .message.user p').filter({ hasText: 'Use Friday.' }).waitFor({ state: 'visible' });
  await ctx.waitFor(async () => {
    speechOutput = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput);
    return speechOutput.includes('The launch plan now uses Friday.');
  }, 15_000);
  const resumedVoiceState = await ctx.alphaPage!.evaluate(async ({ id, text }: { id: string; text: string }) => {
    const snapshot = await (await fetch('/api/state')).json() as { tasks: { id: string; instruction: string; status: string; result: string | null }[] };
    return snapshot.tasks.filter(task => task.id === id && task.instruction.includes(text));
  }, { id: waitingVoiceTask.id, text: clarification });
  assert.equal(resumedVoiceState.length, 1, 'A spoken answer must resume the same task instead of creating another');
  assert.equal(resumedVoiceState[0]?.status, 'done');
  assert.equal(resumedVoiceState[0]?.result, 'The launch plan now uses Friday.');
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-spoken-clarification-resumed');
  const clarificationPrompts = ctx.mockModelPrompts.slice(clarificationPromptStart).filter(prompt => prompt.includes(clarification));
  assert.equal(clarificationPrompts.length, 2, 'The original voice task and its spoken reply should use one task lifecycle');
  assert.match(clarificationPrompts[1] || '', /Task: E2E voice clarification — ask which launch date to use\n\nUser reply: Use Friday\./);

  let voiceStatePollingRequests = 0;
  const countVoiceStatePolling = (request: { url(): string }) => {
    if (new URL(request.url()).pathname === '/api/state') voiceStatePollingRequests += 1;
  };
  ctx.alphaPage!.on('request', countVoiceStatePolling);
  const instruction = 'E2E voice request — finish after the call ends';
  await ctx.alphaPage!.evaluate((text: string) => {
    const pageWindow = window as unknown as { __dotsFakeRecognition?: { emit: (value: string) => void } };
    pageWindow.__dotsFakeRecognition?.emit(text);
  }, instruction);
  await ctx.alphaPage!.locator('.timeline .message.user p').filter({ hasText: instruction }).waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByText('最近的对话和进度', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await call.isVisible(), true, 'Recognizing a voice turn must keep the call open over the Dot conversation');
  await ctx.waitFor(() => Boolean(ctx.heldVoiceModelRelease), 10_000);
  await ctx.waitFor(async () => (await call.getByTestId('voice-call-transcript').getAttribute('data-task-status'))?.includes('Dot 正在处理') || false, 10_000);
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-task-running');
  speechOutput = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput);
  assert(speechOutput.includes('收到，已加入工作队列。'), 'The call should speak its queue acknowledgement when speaker output is enabled');
  const responseInstruction = 'E2E voice response — speak actual task result';
  await ctx.alphaPage!.evaluate((text: string) => {
    const pageWindow = window as unknown as { __dotsFakeRecognition?: { emit: (value: string) => void } };
    pageWindow.__dotsFakeRecognition?.emit(text);
  }, responseInstruction);
  await ctx.alphaPage!.locator('.timeline .message.user p').filter({ hasText: responseInstruction }).waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByText('最近的对话和进度', { exact: true }).waitFor({ state: 'visible' });
  await ctx.waitFor(async () => {
    speechOutput = await ctx.alphaPage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput);
    return speechOutput.includes('Voice response returned from the model.');
  }, 10_000);
  assert(speechOutput.includes('Voice response returned from the model.'), 'The call should speak the completed task result, not only acknowledge receipt');
  await ctx.alphaPage!.locator('.timeline .message.dot').filter({ hasText: 'Voice response returned from the model.' }).waitFor({ state: 'visible' });
  assert.equal(await call.isVisible(), true, 'The Agent answer must return to the Dot conversation without navigating away from the active call');
  assert.equal(voiceStatePollingRequests, 0, 'Voice task progress should arrive on the authenticated event stream instead of polling /api/state');
  ctx.alphaPage!.off('request', countVoiceStatePolling);
  const composer = ctx.alphaPage!.getByTestId('task-composer');
  await composer.fill('Typed while the voice call is active');
  assert.equal(await composer.inputValue(), 'Typed while the voice call is active');
  await composer.fill('');
  await call.getByRole('button', { name: '结束通话' }).click();
  await call.waitFor({ state: 'hidden' });
  ctx.releaseHeldVoiceModel();
  await ctx.alphaPage!.waitForFunction(async (text: string) => {
    const snapshot = await (await fetch('/api/state')).json() as { tasks: { instruction: string; status: string; result: string | null }[] };
    return snapshot.tasks.some(task => task.instruction === text && task.status === 'done' && task.result === 'Voice request finished after the call ended.');
  }, instruction, { timeout: 15_000 });
  const alphaCalls = await ctx.alphaPage!.evaluate(async () => await fetch('/api/voice-calls').then(response => response.json())) as { id: string; startedAt: string; endedAt: string | null; durationSeconds: number | null }[];
  assert.equal(alphaCalls.length, 7, 'Three profile viewport checks plus mobile and desktop conversation header, context panel, and composer must each persist a call');
  assert(alphaCalls.every(item => item.endedAt), 'Ending each call must persist its completion time');
  assert(alphaCalls.some(item => item.durationSeconds !== null && item.durationSeconds >= 1));

  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  await ctx.alphaPage!.waitForFunction(() => document.querySelectorAll('.timeline [data-testid="chat-timeline-item"].voice-call-ended').length === 7, null, { timeout: 10_000 });
  await ctx.alphaPage!.waitForFunction(() => {
    const timeline = document.querySelector('.timeline');
    const composer = document.querySelector('.composer-wrap');
    return Boolean(timeline && timeline.scrollHeight > timeline.clientHeight + 48 && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= 48 && composer && composer.getBoundingClientRect().bottom <= window.innerHeight + 1 && document.documentElement.scrollHeight <= window.innerHeight + 1);
  }, null, { timeout: 5_000 });
  const scrollPane = ctx.alphaPage!.locator('.timeline');
  const scrollBox = await scrollPane.boundingBox();
  const composerBeforeScroll = await ctx.alphaPage!.locator('.composer-wrap').boundingBox();
  const detailsBeforeScroll = await ctx.alphaPage!.locator('.dot-context-panel').boundingBox();
  assert(scrollBox && composerBeforeScroll && detailsBeforeScroll, 'Conversation scrolling needs visible panes');
  assert.equal(scrollBox.x + scrollBox.width, detailsBeforeScroll.x, 'The chat scrollbar must sit against the details divider');
  await scrollPane.evaluate(element => { element.scrollTop = 0; });
  await ctx.alphaPage!.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
  await ctx.alphaPage!.mouse.wheel(0, 400);
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('.timeline')!.scrollTop > 0);
  await scrollPane.evaluate(element => { element.scrollTop = 0; });
  await ctx.alphaPage!.mouse.move(scrollBox.x + scrollBox.width - 6, scrollBox.y + 12);
  await ctx.alphaPage!.mouse.down();
  await ctx.alphaPage!.mouse.move(scrollBox.x + scrollBox.width - 6, scrollBox.y + 180, { steps: 12 });
  await ctx.alphaPage!.mouse.up();
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('.timeline')!.scrollTop > 0);
  assert.deepEqual(await ctx.alphaPage!.locator('.composer-wrap').boundingBox(), composerBeforeScroll,
    'Scrolling and dragging the chat scrollbar should leave the composer fixed');
  assert.deepEqual(await ctx.alphaPage!.locator('.dot-context-panel').boundingBox(), detailsBeforeScroll,
    'The details pane should not move with the conversation');
  await scrollPane.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const timelineTimes = await ctx.alphaPage!.locator('.timeline [data-testid="chat-timeline-item"]').evaluateAll(elements => elements.map(element => Date.parse(element.getAttribute('data-timestamp') || '')));
  assert(timelineTimes.every((time, index) => index === 0 || timelineTimes[index - 1]! <= time), 'Conversation entries and ended-call chips must appear in chronological order');
  assert.equal(await ctx.alphaPage!.getByText('通话结束', { exact: true }).count(), 7, 'Each intentional call must have exactly one ended-call chip');
  assert.equal(await ctx.alphaPage!.getByText('Optional', { exact: true }).count(), 0, 'Call history must show real time information instead of placeholder text');
  for (const record of alphaCalls) {
    const entry = ctx.alphaPage!.locator(`.voice-call-ended[data-call-id="${record.id}"]`);
    assert.deepEqual(await entry.locator('time').evaluateAll(times => times.map(time => time.getAttribute('datetime'))), [record.startedAt, record.endedAt]);
    const seconds = record.durationSeconds!;
    const duration = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    assert.equal(await entry.getByTestId('voice-call-duration').innerText(), `时长 ${duration}`);
  }
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-ended-in-conversation');
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  await ctx.alphaPage!.waitForFunction(() => document.querySelectorAll('.timeline .voice-call-ended').length === 7, null, { timeout: 10_000 });
  await ctx.alphaPage!.waitForFunction(() => {
    const timeline = document.querySelector('.timeline');
    const composer = document.querySelector('.composer-wrap');
    return Boolean(timeline && timeline.scrollHeight > timeline.clientHeight + 48 && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= 48 && composer && composer.getBoundingClientRect().bottom <= window.innerHeight + 1 && document.documentElement.scrollHeight <= window.innerHeight + 1);
  }, null, { timeout: 5_000 });
  await ctx.screenshot(ctx.alphaPage!, 'voice-call-ended-after-reload');
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha workspace');
  await ctx.alphaPage!.waitForFunction(() => document.querySelectorAll('.timeline .voice-call-ended').length === 0, null, { timeout: 10_000 });
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
  await ctx.alphaPage!.waitForFunction(() => document.querySelectorAll('.timeline .voice-call-ended').length === 7, null, { timeout: 10_000 });

  await ctx.selectTenant(ctx.betaPage!, 'Alpha Shared');
  const betaSharedCalls = await ctx.betaPage!.evaluate(async () => await fetch('/api/voice-calls').then(response => response.json()));
  assert.deepEqual(betaSharedCalls, [], 'Another workspace member must not read the call owner\'s history');
  await ctx.selectTenant(ctx.betaPage!, 'Beta workspace');
  const betaPersonalCalls = await ctx.betaPage!.evaluate(async () => await fetch('/api/voice-calls').then(response => response.json()));
  assert.deepEqual(betaPersonalCalls, [], 'A different tenant must not read the call history');
}
