import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function mobileVoiceCall(ctx: UiScenarioContext) {
  ctx.mobileContext = await ctx.browser!.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone'],
  });
  ctx.mobilePage = await ctx.mobileContext.newPage();
  ctx.mobilePage.on('pageerror', error => ctx.pageErrors.push(`mobile: ${error.message}`));
  await ctx.mobilePage.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded' });
  await ctx.mobilePage.getByTestId('e2e-sign-in').waitFor({ state: 'visible' });
  await ctx.mobilePage.setViewportSize({ width: 320, height: 640 });
  const narrowLoginCard = await ctx.mobilePage.locator('.auth-card').boundingBox();
  const narrowLoginButton = await ctx.mobilePage.getByTestId('e2e-sign-in').boundingBox();
  assert(narrowLoginCard && narrowLoginCard.x >= 0 && narrowLoginCard.x + narrowLoginCard.width <= 320,
    'The mobile login card must also fit a narrow 320-pixel phone viewport');
  assert(narrowLoginButton && narrowLoginButton.height >= 44,
    'The Google sign-in control must remain touch-sized on a narrow phone');
  assert.equal(await ctx.mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The narrow mobile login view must not scroll horizontally');
  await ctx.mobilePage.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(await ctx.mobilePage.evaluate(() => ({
    width: window.innerWidth,
    touch: navigator.maxTouchPoints > 0,
    mobileLayout: window.matchMedia('(max-width: 520px)').matches,
  })), { width: 390, touch: true, mobileLayout: true }, 'Chrome must run with a phone viewport and touch input, not only a resized desktop window');
  const loginCard = await ctx.mobilePage.locator('.auth-card').boundingBox();
  assert(loginCard && loginCard.x >= 0 && loginCard.x + loginCard.width <= 390, 'The mobile login card must fit the phone viewport');
  const loginButton = await ctx.mobilePage.getByTestId('e2e-sign-in').boundingBox();
  assert(loginButton && loginButton.height >= 44, 'The mobile sign-in action must be touch-sized');
  assert.equal(await ctx.mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'The mobile login view must not scroll horizontally');
  await ctx.screenshot(ctx.mobilePage, 'mobile-chrome-login-390');

  await ctx.signIn(ctx.mobilePage, 'alpha@example.test');
  await ctx.mobilePage.getByTestId('conversation-call-launch').waitFor({ state: 'visible' });
  assert.equal(await ctx.mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'The signed-in Dot conversation must fit without horizontal overflow');
  await ctx.mobilePage.setViewportSize({ width: 320, height: 640 });
  const narrowChatCallButton = await ctx.mobilePage.getByTestId('conversation-call-launch').boundingBox();
  assert(narrowChatCallButton && narrowChatCallButton.width >= 44 && narrowChatCallButton.height >= 44,
    'The Dot conversation call entry must remain touch-sized on a narrow phone');
  assert.equal(await ctx.mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The authenticated Dot conversation must not overflow a narrow phone viewport');
  await ctx.mobilePage.setViewportSize({ width: 390, height: 844 });
  await ctx.screenshot(ctx.mobilePage, 'mobile-chrome-dot-chat-390');

  await ctx.mobilePage.evaluate((script: string) => window.eval(script), ctx.browserVoiceMockScript());
  const callsBefore = await ctx.mobilePage.evaluate(async () => (await fetch('/api/voice-calls').then(response => response.json()) as { id: string }[]).length);
  await ctx.mobilePage.getByTestId('conversation-call-launch').click();
  const call = ctx.mobilePage.getByTestId('voice-call');
  await call.waitFor({ state: 'visible' });
  await ctx.mobilePage.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__dotsFakeRecognition), null, { timeout: 10_000 });
  assert.equal(await call.getAttribute('data-variant'), 'mobile', 'A real mobile Chrome context must use the phone call surface');
  const callBounds = await call.boundingBox();
  assert(callBounds && callBounds.x === 0 && callBounds.y === 0 && callBounds.width === 390 && callBounds.height === 844, 'The mobile call surface must fill the phone viewport');
  await ctx.waitFor(async () => {
    const output = await ctx.mobilePage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput);
    return output.some(text => text.startsWith('你好，我是 ') && text.endsWith('有什么我可以帮你？'));
  }, 10_000);
  const mobileGreetingSequence = await ctx.mobilePage.evaluate(() => (window as unknown as { __dotsVoiceEvents: string[] }).__dotsVoiceEvents.slice(0, 2));
  assert.deepEqual(mobileGreetingSequence.map(event => event === 'listening' ? 'listening' : event.startsWith('spoken:你好，我是 ') ? 'spoken:greeting' : event),
    ['spoken:greeting', 'listening'], 'The mobile call must speak its Chinese greeting before starting speech recognition');
  await ctx.mobilePage.setViewportSize({ width: 320, height: 640 });
  const narrowCallBounds = await call.boundingBox();
  const narrowCallControls = await call.locator('.voice-call-mobile-controls').boundingBox();
  assert(narrowCallBounds && narrowCallBounds.x === 0 && narrowCallBounds.y === 0 && narrowCallBounds.width === 320 && narrowCallBounds.height === 640,
    'The phone call surface must fill a narrow 320×640 viewport');
  assert(narrowCallControls && narrowCallControls.x >= 0 && narrowCallControls.y >= 0 && narrowCallControls.x + narrowCallControls.width <= 320 && narrowCallControls.y + narrowCallControls.height <= 640,
    'Speaker, red hang-up, and mute must stay inside the narrow phone viewport');
  assert.equal(await ctx.mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The narrow mobile call must not scroll horizontally');
  assert.equal(await call.locator('.voice-call-mobile-controls button').count(), 3,
    'All three phone call controls must remain available on a narrow viewport');
  await call.screenshot({ path: join(ctx.screenshotsDir, 'mobile-chrome-call-active-320.png') });
  ctx.screenshotNames.push('mobile-chrome-call-active-320.png');
  await ctx.mobilePage.setViewportSize({ width: 390, height: 844 });
  await ctx.screenshot(ctx.mobilePage, 'mobile-chrome-call-active-390');
  await call.screenshot({ path: join(ctx.screenshotsDir, 'mobile-chrome-call-active-390.png') });
  ctx.screenshotNames.push('mobile-chrome-call-active-390.png');
  assert.equal(await call.locator('.voice-call-mobile-controls button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')).join('|')),
    '关闭扬声器|结束通话|静音', 'Phone call controls must keep speaker, red hang-up, and mute in the observed order');
  const activeMobileCallBeforeChat = await ctx.mobilePage.evaluate(async () => (await fetch('/api/voice-calls').then(response => response.json()) as { id: string; endedAt: string | null }[]).find(item => !item.endedAt) || null);
  assert(activeMobileCallBeforeChat, 'The mobile call must have an active persisted call record before opening chat');
  await call.getByTestId('voice-call-minimize').click();
  await ctx.mobilePage.waitForFunction(() => document.querySelector('[data-testid="voice-call"]')?.getAttribute('data-variant') === 'mobile-minimized');
  assert.equal(await call.getAttribute('aria-modal'), 'false', 'The minimized call must release modal focus so the conversation can be used');
  const minimizedCallBounds = await call.boundingBox();
  assert(minimizedCallBounds && minimizedCallBounds.width < 390 && minimizedCallBounds.height < 390,
    'Returning to chat must keep the active call visible as a compact floating card');
  const minimizedTouchControls = await call.locator('.voice-call-card-controls button').evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  assert(minimizedTouchControls.length === 3 && minimizedTouchControls.every(box => box.width >= 44 && box.height >= 44),
    'The minimized mobile call controls must remain touch-sized');
  const restoreCallBounds = await call.getByTestId('voice-call-restore').boundingBox();
  assert(restoreCallBounds && restoreCallBounds.width >= 44 && restoreCallBounds.height >= 44,
    'The return-to-call action must remain touch-sized');
  assert.equal(await ctx.mobilePage.getByTestId('task-composer').isVisible(), true,
    'The text composer must remain usable while a mobile call is active');
  await ctx.screenshot(ctx.mobilePage, 'mobile-chrome-call-minimized-chat-390');
  const typedDuringCall = '通话中补充：请用中文整理重点。';
  await ctx.mobilePage.getByTestId('task-composer').fill(typedDuringCall);
  await ctx.mobilePage.locator('.composer .send').click();
  await ctx.mobilePage.locator('.timeline .message.user p').filter({ hasText: typedDuringCall }).waitFor({ state: 'visible' });
  assert.equal(await call.getAttribute('data-variant'), 'mobile-minimized', 'Sending text must not end or expand the active mobile call');
  const activeMobileCallAfterChat = await ctx.mobilePage.evaluate(async () => (await fetch('/api/voice-calls').then(response => response.json()) as { id: string; endedAt: string | null }[]).find(item => !item.endedAt) || null);
  assert.deepEqual(activeMobileCallAfterChat, activeMobileCallBeforeChat,
    'Typing into the same Dot chat must preserve the active call session');
  await call.getByTestId('voice-call-restore').click();
  await ctx.mobilePage.waitForFunction(() => document.querySelector('[data-testid="voice-call"]')?.getAttribute('data-variant') === 'mobile');
  const activeMobileCallAfterRestore = await ctx.mobilePage.evaluate(async () => (await fetch('/api/voice-calls').then(response => response.json()) as { id: string; endedAt: string | null }[]).find(item => !item.endedAt) || null);
  assert.deepEqual(activeMobileCallAfterRestore, activeMobileCallBeforeChat,
    'Returning to the phone screen must resume the same persisted call rather than starting a new call');
  await ctx.mobilePage.setViewportSize({ width: 844, height: 390 });
  await ctx.mobilePage.waitForFunction(() => document.querySelector('[data-testid="voice-call"]')?.getAttribute('data-variant') === 'mobile');
  await ctx.mobilePage.waitForFunction(() => {
    const controls = document.querySelector('.voice-call-mobile-controls');
    const box = controls?.getBoundingClientRect();
    return Boolean(controls && getComputedStyle(controls).display !== 'none' && box && box.width >= 300 && box.height >= 80 && box.bottom <= window.innerHeight);
  });
  const landscapeCallBounds = await call.boundingBox();
  assert(landscapeCallBounds && landscapeCallBounds.x === 0 && landscapeCallBounds.y === 0 && landscapeCallBounds.width === 844 && landscapeCallBounds.height === 390,
    'A touch-first phone in landscape must keep the full-screen call surface instead of switching to the desktop float');
  const landscapeControlsBounds = await call.locator('.voice-call-mobile-controls').boundingBox();
  assert(landscapeControlsBounds && landscapeControlsBounds.width >= 300 && landscapeControlsBounds.height >= 80 && landscapeControlsBounds.y + landscapeControlsBounds.height <= 390,
    'Speaker, hang-up, and mute must remain visible inside the landscape phone viewport');
  assert.equal(await ctx.mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The landscape call page must not overflow horizontally');
  await ctx.screenshot(ctx.mobilePage, 'mobile-chrome-call-landscape-844');
  await call.screenshot({ path: join(ctx.screenshotsDir, 'mobile-chrome-call-landscape-844-surface.png') });
  ctx.screenshotNames.push('mobile-chrome-call-landscape-844-surface.png');
  await ctx.mobilePage.setViewportSize({ width: 390, height: 844 });
  await ctx.mobilePage.waitForFunction(() => document.querySelector('[data-testid="voice-call"]')?.getAttribute('data-variant') === 'mobile');
  await call.getByRole('button', { name: '静音' }).click();
  assert.equal(await call.getByRole('button', { name: '取消静音' }).getAttribute('aria-pressed'), 'true');
  await call.getByRole('button', { name: '取消静音' }).click();

  const mobileVoiceGoal = '帮我准备明天的会议资料';
  const mobileVoiceReply = '重点整理产品进展、项目风险和需要我决定的事项。';
  await ctx.mobilePage.evaluate((text: string) => {
    const pageWindow = window as unknown as { __dotsFakeRecognition?: { emit: (value: string) => void } };
    pageWindow.__dotsFakeRecognition?.emit(text);
  }, mobileVoiceGoal);
  await ctx.mobilePage.locator('.timeline .message.user p').filter({ hasText: mobileVoiceGoal }).waitFor({ state: 'visible' });
  await ctx.mobilePage.locator('.timeline .message.dot p').filter({ hasText: '你希望会前资料重点覆盖哪些主题？' }).waitFor({ state: 'visible', timeout: 15_000 });
  const waitingMobileVoiceTask = await ctx.mobilePage.evaluate(async (text: string) => {
    const snapshot = await (await fetch('/api/state')).json() as { tasks: { id: string; instruction: string; status: string }[] };
    return snapshot.tasks.find(task => task.instruction === text);
  }, mobileVoiceGoal);
  assert(waitingMobileVoiceTask && waitingMobileVoiceTask.status === 'waiting', 'The phone transcript must create a persisted task that can ask the user a follow-up question');
  await ctx.waitFor(async () => {
    const output = await ctx.mobilePage!.evaluate(() => (window as unknown as { __dotsSpeechOutput: string[] }).__dotsSpeechOutput);
    return output.includes('你希望会前资料重点覆盖哪些主题？');
  }, 10_000);
  assert.equal(await call.isVisible(), true, 'The Dot clarification must be spoken without leaving the mobile phone call');

  await ctx.mobilePage.evaluate((text: string) => {
    const pageWindow = window as unknown as { __dotsFakeRecognition?: { emit: (value: string) => void } };
    pageWindow.__dotsFakeRecognition?.emit(text);
  }, mobileVoiceReply);
  await ctx.mobilePage.locator('.timeline .message.user p').filter({ hasText: mobileVoiceReply }).waitFor({ state: 'visible' });
  await ctx.waitFor(() => Boolean(ctx.heldMobileVoiceModelRelease), 10_000);
  assert.equal(await call.isVisible(), true, 'The mobile call must stay available while the Agent works on the spoken follow-up');
  assert.match(await ctx.mobilePage.getByTestId('voice-call-transcript').getAttribute('data-task-status') || '', /^Dot 正在处理：/);

  // Hanging up ends the voice channel, while the tenant-scoped Agent task continues.
  await call.getByRole('button', { name: '结束通话' }).click();
  await call.waitFor({ state: 'hidden' });
  const mobileCallRecord = await ctx.mobilePage.evaluate(async () => await fetch('/api/voice-calls').then(response => response.json())) as { id: string; endedAt: string | null }[];
  assert.equal(mobileCallRecord.length, callsBefore + 1, 'Starting a call from the mobile chat must create one durable call record');
  assert(mobileCallRecord.at(-1)?.endedAt, 'The red hang-up action must close and persist the mobile call');
  const releaseMobileVoiceModel = ctx.heldMobileVoiceModelRelease;
  assert(releaseMobileVoiceModel, 'The test Agent reply should still be pending when the user hangs up');
  releaseMobileVoiceModel();
  await ctx.mobilePage.waitForFunction(async ({ id, text }: { id: string; text: string }) => {
    const snapshot = await (await fetch('/api/state')).json() as { tasks: { id: string; instruction: string; status: string; result: string | null }[] };
    const task = snapshot.tasks.find(item => item.id === id && item.instruction === text);
    return task?.status === 'done' && task.result === '好的，我会把产品进展、风险和待决策事项整理成会前资料。';
  }, { id: waitingMobileVoiceTask.id, text: mobileVoiceGoal }, { timeout: 15_000 });
  await ctx.mobilePage.locator('.timeline .message.dot p').filter({ hasText: '好的，我会把产品进展、风险和待决策事项整理成会前资料。' }).waitFor({ state: 'visible' });
  const mobileVoicePrompt = ctx.mockModelPrompts.filter(prompt => prompt.includes(mobileVoiceGoal));
  assert.equal(mobileVoicePrompt.length, 2, 'The spoken clarification must resume the original task instead of creating a second task');
  assert.match(mobileVoicePrompt[1] || '', /Task: 帮我准备明天的会议资料[\s\S]*User reply: 重点整理产品进展、项目风险和需要我决定的事项。/);
  const mobileCallHistory = await ctx.mobilePage.evaluate(async () => await fetch('/api/voice-calls').then(response => response.json())) as { id: string; endedAt: string | null }[];
  assert.deepEqual(mobileCallHistory, mobileCallRecord, 'Finishing the background task must not reopen or mutate the ended phone call');
  await ctx.screenshot(ctx.mobilePage, 'mobile-chrome-call-ended-390');
}
