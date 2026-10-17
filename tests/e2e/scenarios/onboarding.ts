import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function signedOutControls(ctx: UiScenarioContext) {
  await ctx.alphaPage!.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('e2e-sign-in').waitFor({ state: 'visible' });
  await ctx.alphaPage!.setViewportSize({ width: 390, height: 844 });
  const mobileLogin = await ctx.alphaPage!.locator('.auth-card').boundingBox();
  assert(mobileLogin && mobileLogin.x >= 0 && mobileLogin.x + mobileLogin.width <= 390,
    'The Google login card must fit a 390 px mobile Chrome viewport');
  const mobileGoogleLogin = ctx.alphaPage!.locator('a.google-login');
  if (await mobileGoogleLogin.count()) {
    assert(await mobileGoogleLogin.isVisible(), 'Configured Google OAuth must remain directly available from mobile Chrome');
  } else {
    assert(await ctx.alphaPage!.locator('.auth-setup').isVisible(), 'An unconfigured Google OAuth state must remain visible on mobile');
  }
  const mobileTestLogin = ctx.alphaPage!.getByTestId('e2e-sign-in');
  const mobileTestLoginBox = await mobileTestLogin.boundingBox();
  assert(mobileTestLoginBox && mobileTestLoginBox.height >= 44,
    'The mobile sign-in action must remain a touch-sized target');
  assert.equal(await ctx.alphaPage!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The mobile login page must not scroll horizontally');
  await ctx.screenshot(ctx.alphaPage!, '01-login-mobile-390');
  await ctx.alphaPage!.setViewportSize({ width: 1440, height: 1000 });
  await ctx.screenshot(ctx.alphaPage!, '01-login');
}

export async function signInAlpha(ctx: UiScenarioContext) {
  await ctx.signIn(ctx.alphaPage!, 'alpha@example.test');
  await ctx.alphaPage!.getByTestId('app-shell').waitFor();
  await ctx.alphaPage!.getByTestId('chat-home').getByRole('heading', { name: "What's on your mind today?" }).waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.locator('.icon-rail').evaluate(element => Math.round(element.getBoundingClientRect().width)), 44);
  assert.equal(await ctx.alphaPage!.locator('.sidebar').evaluate(element => Math.round(element.getBoundingClientRect().width)), 224);
  const surfaceSwitcher = ctx.alphaPage!.getByTestId('surface-switcher');
  assert.equal(await surfaceSwitcher.getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed'), 'true');
  await surfaceSwitcher.getByRole('button', { name: 'Work' }).click();
  assert.equal(await surfaceSwitcher.getByRole('button', { name: 'Work' }).getAttribute('aria-pressed'), 'true');
  await ctx.alphaPage!.getByRole('heading', { name: 'Activity', exact: true }).waitFor({ state: 'visible' });
  await surfaceSwitcher.getByRole('button', { name: 'Chat' }).click();
  await ctx.alphaPage!.getByTestId('chat-home').waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.locator('.profile-link small').innerText(), 'alpha@example.test');
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'light');
  assert.equal(await ctx.alphaPage!.locator('.sidebar').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(247, 247, 248)');
  assert.equal(await ctx.alphaPage!.locator('.main').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await ctx.alphaPage!.getByTestId('dot-context-panel').count(), 0, 'A new-dot welcome state should not show the post-setup details panel');
  const homeComposerLayout = await ctx.alphaPage!.locator('.composer').evaluate(element => {
    const composer = element.getBoundingClientRect();
    const textarea = element.querySelector('textarea')!.getBoundingClientRect();
    const dictationButton = element.querySelector<HTMLButtonElement>('[data-testid="dictation-button"]')!.getBoundingClientRect();
    const callButton = element.querySelector<HTMLButtonElement>('[data-testid="voice-call-launch"]')!.getBoundingClientRect();
    const main = element.closest('main')!.getBoundingClientRect();
    const heading = element.closest('.chat-panel')!.querySelector('.chat-home h1')!.getBoundingClientRect();
    return {
      height: composer.height,
      centerX: composer.left + composer.width / 2,
      centerY: composer.top + composer.height / 2,
      mainCenterX: main.left + main.width / 2,
      topRatio: (composer.top - main.top) / main.height,
      headingGap: composer.top - heading.bottom,
      inputDictationDeltaY: Math.abs(textarea.top + textarea.height / 2 - (dictationButton.top + dictationButton.height / 2)),
      inputCallDeltaY: Math.abs(textarea.top + textarea.height / 2 - (callButton.top + callButton.height / 2)),
    };
  });
  assert(homeComposerLayout.height <= 44, 'The landing composer should stay in a compact single row');
  assert(homeComposerLayout.topRatio > 0.41 && homeComposerLayout.topRatio < 0.48, 'The landing composer should sit slightly above the center of the main pane');
  assert(Math.abs(homeComposerLayout.centerX - homeComposerLayout.mainCenterX) <= 1, 'The landing composer should be centered in the main pane');
  assert(homeComposerLayout.headingGap >= 0 && homeComposerLayout.headingGap <= 16, 'The landing heading should sit just above the composer');
  assert(homeComposerLayout.inputDictationDeltaY <= 3, 'The dictation control should align with the composer input');
  assert(homeComposerLayout.inputCallDeltaY <= 3, 'The input and voice control should share one row');
  assert.equal(await ctx.alphaPage!.getByTestId('dictation-button').isVisible(), true, 'The landing composer should expose the separate microphone control seen in V1 at 01:18');
  assert.equal(await ctx.alphaPage!.locator('.home-mode .send').isVisible(), false, 'The empty landing composer should show voice instead of a disabled send arrow');
  await ctx.screenshot(ctx.alphaPage!, '02-alpha-home');
}

export async function supportedEngines(ctx: UiScenarioContext) {
  const options = await ctx.alphaPage!.getByTestId('engine-select').locator('option').evaluateAll(elements => elements.map(element => (element as HTMLOptionElement).value));
  assert.deepEqual(options, ['model', 'pi', 'dsh']);
  assert.equal(await ctx.alphaPage!.getByTestId('engine-select').inputValue(), 'model', 'Local development builds should keep the Model API as the default');
  const legacyAttempt = await ctx.alphaPage!.evaluate(async () => {
    const response = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'E2E legacy Claude engine rejection', engine: 'claude' }) });
    return { status: response.status, body: await response.json() as { error?: string } };
  });
  assert.equal(legacyAttempt.status, 400);
  assert.match(legacyAttempt.body.error || '', /不支持此内核/);
}

export async function themePreference(ctx: UiScenarioContext) {
  const shell = ctx.alphaPage!.getByTestId('app-shell');
  const themeToggle = ctx.alphaPage!.getByTestId('theme-toggle');
  await themeToggle.click();
  assert.equal(await shell.getAttribute('data-theme'), 'dark');
  assert.equal(await ctx.alphaPage!.locator('.sidebar').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(37, 37, 38)');
  assert.equal(await ctx.alphaPage!.locator('.main').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(28, 28, 29)');
  assert.equal(await ctx.alphaPage!.locator('.composer').evaluate(element => Math.round(element.getBoundingClientRect().height)), 40, 'Theme changes should preserve the compact landing composer geometry');
  await ctx.screenshot(ctx.alphaPage!, 'theme-dark');
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await shell.waitFor();
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-theme') === 'dark');
  await themeToggle.click();
  assert.equal(await shell.getAttribute('data-theme'), 'light');
  await ctx.screenshot(ctx.alphaPage!, 'theme-light');
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await shell.waitFor();
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-theme') === 'light');
}

export async function firstRunConversation(ctx: UiScenarioContext) {
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  const onboarding = ctx.alphaPage!.getByTestId('dot-onboarding');
  const computerChoice = ctx.alphaPage!.getByTestId('computer-choice');
  await computerChoice.getByRole('heading', { name: 'Choose where your dot can work' }).waitFor({ state: 'visible' });
  await computerChoice.getByText('Your dot has its own computer, but you can also let it use yours. You can change this anytime.').waitFor({ state: 'visible' });
  assert.equal(await computerChoice.getByRole('radio', { name: 'Your dot’s computer' }).getAttribute('aria-checked'), 'true');
  const localComputerToggle = computerChoice.getByRole('switch', { name: 'Your local computer' });
  assert.equal(await localComputerToggle.isChecked(), true, 'The local-computer switch starts in the observed enabled state');
  await ctx.screenshot(ctx.alphaPage!, 'computer-choice-light');
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'dark');
  assert.equal(await computerChoice.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(9, 9, 11)');
  await ctx.screenshot(ctx.alphaPage!, 'computer-choice-dark');
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  await localComputerToggle.uncheck();
  assert.equal(await localComputerToggle.isChecked(), false);
  await localComputerToggle.check();
  await computerChoice.getByRole('button', { name: 'Continue' }).click();
  const connectedToast = ctx.alphaPage!.getByTestId('computer-connected-toast');
  await connectedToast.waitFor({ state: 'visible' });
  await connectedToast.getByText('The computer is connected to your dot', { exact: true }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, 'computer-connected-toast-light');
  await onboarding.getByRole('heading', { name: 'Hey! I’m your dot' }).waitFor({ state: 'visible' });
  await onboarding.getByText('Message or call me anytime. I’ll keep things moving, even when we’re not talking, and check in with updates or questions.').waitFor({ state: 'visible' });
  assert.equal(await onboarding.locator('.dot-onboarding-messages .message').count(), 2, 'Show only the two welcome messages visible in the timestamp-verified source frame');
  assert.equal(await onboarding.getByText('Want to give me a name?').count(), 0, 'The rechecked video frame does not support this name prompt');
  assert.equal(await onboarding.getByRole('button', { name: 'Customize your dot' }).count(), 1, 'The first-run conversation exposes its observed customization entry');
  assert.equal(await onboarding.getByText('I’ll just call you dot').count(), 0, 'Do not invent a user reply that is absent from the recording');
  const firstBubble = onboarding.locator('.dot-onboarding-messages .message.dot').first();
  const firstBubbleBounds = await firstBubble.boundingBox();
  assert(firstBubbleBounds && firstBubbleBounds.width >= 155 && firstBubbleBounds.width <= 175, 'The welcome bubble should match the measured source-frame width');
  assert.equal(await firstBubble.locator('p').evaluate(element => getComputedStyle(element).fontSize), '12px');
  const onboardingBounds = await onboarding.boundingBox();
  assert(onboardingBounds, 'The onboarding conversation should have visible bounds');
  const firstBubbleOffset = firstBubbleBounds.y - onboardingBounds.y;
  assert(firstBubbleOffset >= 188 && firstBubbleOffset <= 194, `Welcome bubbles should retain their position within the conversation below the toolbar, got ${firstBubbleOffset}`);
  assert.equal(await ctx.alphaPage!.locator('.dot-conversation-avatar').evaluate(element => Math.round(element.getBoundingClientRect().width)), 58);
  assert.equal(await ctx.alphaPage!.locator('.sidebar').evaluate(element => Math.round(element.getBoundingClientRect().width)), 0);
  assert.equal(await ctx.alphaPage!.getByTestId('surface-switcher').isVisible(), false);
  await ctx.alphaPage!.getByRole('button', { name: 'Activity', exact: true }).first().click();
  await ctx.alphaPage!.getByRole('heading', { name: 'Activity', exact: true }).waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByRole('button', { name: '新聊天', exact: true }).click();
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  await onboarding.getByRole('heading', { name: 'Hey! I’m your dot' }).waitFor({ state: 'visible' });
  await connectedToast.waitFor({ state: 'hidden', timeout: 7000 });
  await ctx.screenshot(ctx.alphaPage!, 'onboarding-first-run');
  await onboarding.getByRole('button', { name: 'Customize your dot' }).click();
  const setupEditor = ctx.alphaPage!.getByTestId('dot-setup-backdrop');
  await setupEditor.getByRole('heading', { name: 'Customize your dot' }).waitFor({ state: 'visible' });
  for (const row of ['Colors', 'Characters', 'Pets']) await setupEditor.getByRole('region', { name: row }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, 'dot-setup-editor-light');
  await setupEditor.getByRole('button', { name: 'Blue character' }).click();
  const setupPreview = setupEditor.locator('.dot-setup-avatar-preview .avatar');
  assert.match(await setupPreview.getAttribute('class') || '', /character-blue/);
  assert.match(await setupPreview.getAttribute('class') || '', /accessory-crown/);
  assert.equal(await setupPreview.evaluate(element => getComputedStyle(element).getPropertyValue('--avatar-color').trim()), '#18a6da', 'Choosing the blue character should update the live preview to the blue shown in the source frame');
  await ctx.screenshot(ctx.alphaPage!, 'dot-setup-preview-blue-light');
  await setupEditor.getByRole('button', { name: 'Color #f18ac0' }).click();
  await setupEditor.getByRole('button', { name: 'Triangle character' }).click();
  await setupEditor.getByRole('button', { name: 'Green pet' }).click();
  assert.match(await setupPreview.getAttribute('class') || '', /triangle/);
  assert.match(await setupPreview.getAttribute('class') || '', /pet-moss/);
  assert.equal(await setupPreview.evaluate(element => getComputedStyle(element).getPropertyValue('--avatar-color').trim()), '#f18ac0');
  await ctx.screenshot(ctx.alphaPage!, 'dot-setup-preview-light');
  await setupEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await setupEditor.waitFor({ state: 'hidden' });
  assert.equal(await onboarding.locator('.dot-conversation-identity').innerText(), 'dot');
  assert.equal(await onboarding.locator('.dot-onboarding-messages .message').count(), 2, 'Saving the Color/Characters/Pets editor only saves the first setup stage');
  assert.equal(await onboarding.getByText('Want to give me a name?', { exact: true }).count(), 0);
  assert.equal(await onboarding.getByTestId('onboarding-suggestion-card').count(), 0);
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  await onboarding.getByRole('button', { name: 'Customize your dot' }).click();
  const advancedEditor = ctx.alphaPage!.getByTestId('avatar-editor-backdrop');
  await advancedEditor.getByRole('dialog', { name: 'Customize your dot' }).waitFor({ state: 'visible' });
  for (const tab of ['Shape', 'Eyes', 'Glasses', 'Accessories']) await advancedEditor.getByRole('tab', { name: tab }).waitFor({ state: 'visible' });
  assert.equal(await advancedEditor.getByRole('group', { name: 'Shape options' }).getByRole('button').count(), 11, 'The observed Shape page contains eleven silhouettes');
  assert.equal(await advancedEditor.getByRole('group', { name: 'Color' }).getByRole('button').count(), 9, 'The observed Shape page contains nine color swatches');
  await ctx.screenshot(ctx.alphaPage!, 'avatar-editor-reference-state-dark');
  await advancedEditor.getByRole('button', { name: 'Close customizer' }).click();
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  await onboarding.getByRole('button', { name: 'Customize your dot' }).click();
  await advancedEditor.waitFor({ state: 'visible' });
  await advancedEditor.getByLabel('Dot name').fill('Roger');
  await advancedEditor.getByRole('tab', { name: 'Shape' }).click();
  await advancedEditor.getByRole('button', { name: 'Burst' }).click();
  await advancedEditor.getByRole('button', { name: 'Color #f19b74' }).click();
  await advancedEditor.getByRole('tab', { name: 'Eyes' }).click();
  await advancedEditor.getByRole('button', { name: 'Wide eyes' }).click();
  await advancedEditor.getByRole('tab', { name: 'Glasses' }).click();
  await advancedEditor.getByRole('button', { name: 'Thick glasses' }).click();
  await advancedEditor.getByRole('tab', { name: 'Accessories' }).click();
  await advancedEditor.getByRole('button', { name: 'Crown' }).click();
  const advancedPreview = advancedEditor.locator('.avatar-editor-preview .avatar');
  assert.match(await advancedPreview.getAttribute('class') || '', /scallop/);
  assert.match(await advancedPreview.getAttribute('class') || '', /glasses-thick/);
  assert.match(await advancedPreview.getAttribute('class') || '', /accessory-crown/);
  assert.equal(await advancedPreview.evaluate(element => getComputedStyle(element).getPropertyValue('--avatar-color').trim()), '#f19b74');
  await ctx.screenshot(ctx.alphaPage!, 'dot-advanced-avatar-editor-light');
  await advancedEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await advancedEditor.waitFor({ state: 'hidden' });
  await onboarding.getByText('Want to give me a name?', { exact: true }).waitFor({ state: 'visible' });
  await onboarding.getByRole('button', { name: 'Customize your dot' }).waitFor({ state: 'visible' });
  await onboarding.getByText('I’ll start looking for ways to help. Anything top of mind?', { exact: true }).waitFor({ state: 'visible' });
  const suggestionCard = onboarding.getByTestId('onboarding-suggestion-card');
  await suggestionCard.getByText('A few things I could take off your plate:', { exact: true }).waitFor({ state: 'visible' });
  await suggestionCard.getByText('Want help with any of these?', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await suggestionCard.locator('button').count(), 0, 'Do not turn the unreadable proposal card into unobserved actions');
  assert.equal(await onboarding.getByTestId('onboarding-name-ack').count(), 0, 'The name confirmation follows the suggestions rather than appearing before the observed pause');
  await ctx.screenshot(ctx.alphaPage!, 'onboarding-name-and-suggestions-light');
  await onboarding.getByTestId('onboarding-name-ack').waitFor({ state: 'visible', timeout: 8000 });
  assert.equal((await onboarding.getByTestId('onboarding-name-ack').innerText()).trim(), 'Roger it is! ❤️');
  await ctx.screenshot(ctx.alphaPage!, 'onboarding-name-confirmation-light');
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'dark');
  assert.equal(await suggestionCard.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(16, 38, 27)');
  await ctx.screenshot(ctx.alphaPage!, 'onboarding-name-and-suggestions-dark');
  await onboarding.getByRole('button', { name: 'Customize your dot' }).click();
  await advancedEditor.waitFor({ state: 'visible' });
  assert.equal(await onboarding.locator('.dot-onboarding-messages .message').first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(16, 38, 27)');
  await ctx.screenshot(ctx.alphaPage!, 'dot-advanced-avatar-editor-dark');
  await advancedEditor.getByLabel('Dot name').fill('Roger');
  await advancedEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await advancedEditor.waitFor({ state: 'hidden' });
  assert.equal(await onboarding.locator('.dot-conversation-identity').innerText(), 'Roger', 'Saving the name should update the conversation identity');
  await onboarding.getByRole('button', { name: '打开你的 dot 设置' }).click();
  await advancedEditor.waitFor({ state: 'visible' });
  await advancedEditor.getByLabel('Dot name').fill('dot');
  await advancedEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await advancedEditor.waitFor({ state: 'hidden' });
  assert.equal(await onboarding.locator('.dot-conversation-identity').innerText(), 'dot');
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'light');
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('.profile-link .avatar')?.classList.contains('scallop'));
  assert.match(await ctx.alphaPage!.locator('.profile-link .avatar').getAttribute('class') || '', /pet-moss/);
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByRole('heading', { name: '你的 dot' }).waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.getByLabel('名字').inputValue(), 'dot');
  await ctx.alphaPage!.getByRole('button', { name: '更改电脑访问' }).click();
  const computerAccessDialog = ctx.alphaPage!.getByTestId('computer-access-dialog');
  const settingsToggle = computerAccessDialog.getByRole('switch', { name: 'Your local computer' });
  await settingsToggle.waitFor({ state: 'visible' });
  await settingsToggle.uncheck();
  await computerAccessDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await computerAccessDialog.waitFor({ state: 'hidden' });
  assert.equal(await ctx.alphaPage!.getByText('已关闭本机 Chrome 工作区访问。').isVisible(), true);
  await ctx.clickNav(ctx.alphaPage!, '电脑');
  await ctx.alphaPage!.getByTestId('computer-access-disabled').waitFor({ state: 'visible' });
  const blockedComputerOpen = await ctx.alphaPage!.evaluate(async () => {
    const response = await fetch('/api/computer/open', { method: 'POST' });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(blockedComputerOpen.status, 403, 'The server must enforce the local-computer choice');
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByRole('button', { name: '更改电脑访问' }).click();
  const accessDialog = ctx.alphaPage!.getByTestId('computer-access-dialog');
  assert.equal(await accessDialog.getByRole('switch', { name: 'Your local computer' }).isChecked(), false, 'Computer access settings persist across opening the editor');
  await accessDialog.getByRole('button', { name: 'Cancel' }).click();
  await accessDialog.waitFor({ state: 'hidden' });
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'dark');
  await ctx.alphaPage!.getByRole('button', { name: '更改电脑访问' }).click();
  const enableComputerDialog = ctx.alphaPage!.getByTestId('computer-access-dialog');
  await enableComputerDialog.getByRole('switch', { name: 'Your local computer' }).check();
  await enableComputerDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await enableComputerDialog.waitFor({ state: 'hidden' });
  await ctx.alphaPage!.getByTestId('computer-connected-toast').waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.getByTestId('computer-connected-toast').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(23, 42, 29)');
  await ctx.screenshot(ctx.alphaPage!, 'computer-connected-toast-dark');
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'light');
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByRole('button', { name: '更改电脑访问' }).click();
  assert.equal(await ctx.alphaPage!.getByTestId('computer-access-dialog').getByRole('switch', { name: 'Your local computer' }).isChecked(), true, 'Computer settings survive a browser reload');
  await ctx.alphaPage!.getByTestId('computer-access-dialog').getByRole('button', { name: 'Cancel' }).click();
  await ctx.alphaPage!.getByTestId('computer-access-dialog').waitFor({ state: 'hidden' });
  await ctx.clickNav(ctx.alphaPage!, 'Scratchpad');
  await ctx.alphaPage!.getByRole('heading', { name: 'Your Personal Scratchpad' }).waitFor({ state: 'visible' });
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  const composer = ctx.alphaPage!.getByTestId('task-composer');
  await composer.click();
  assert.equal(await composer.evaluate(element => document.activeElement === element), true, 'The chat composer should receive focus on click');
}

export async function customizeAppearance(ctx: UiScenarioContext) {
  await ctx.openProfile(ctx.alphaPage!);
  const editor = ctx.alphaPage!.getByRole('dialog', { name: 'Customize your dot' });
  await ctx.alphaPage!.getByRole('button', { name: 'Customize your dot' }).click();
  await editor.waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'light');
  await ctx.screenshot(ctx.alphaPage!, 'avatar-customizer-light');

  await editor.getByRole('tab', { name: 'Eyes' }).click();
  assert.equal(await editor.getByRole('group', { name: 'Color' }).count(), 0, 'The observed Eyes grid has no color row');
  await editor.getByRole('button', { name: 'Sparkle eyes' }).click();
  await editor.getByRole('tab', { name: 'Glasses' }).click();
  assert.equal(await editor.getByRole('group', { name: 'Color' }).count(), 0, 'The observed Glasses grid has no color row');
  await editor.getByRole('button', { name: 'Round glasses' }).click();
  await editor.getByRole('tab', { name: 'Accessories' }).click();
  assert.equal(await editor.getByRole('group', { name: 'Color' }).count(), 1, 'The observed Accessories grid retains its color row');
  await editor.getByRole('button', { name: 'Crown' }).click();
  await editor.getByRole('tab', { name: 'Shape' }).click();
  assert.equal(await editor.getByRole('group', { name: 'Color' }).count(), 1, 'The observed Shape grid retains its color row');
  await editor.getByRole('button', { name: 'Heart', exact: true }).click();
  await editor.getByRole('button', { name: 'Color #f19b74' }).click();
  const preview = editor.locator('.avatar-editor-preview .avatar');
  assert.match(await preview.getAttribute('class') || '', /heart/);
  assert.match(await preview.getAttribute('class') || '', /eyes-sparkle/);
  assert.match(await preview.getAttribute('class') || '', /glasses-round/);
  assert.match(await preview.getAttribute('class') || '', /accessory-crown/);
  assert.equal(await preview.locator('.avatar-face path').evaluate(element => getComputedStyle(element).fill), 'rgb(241, 155, 116)');
  assert.equal(await preview.evaluate(element => getComputedStyle(element).clipPath), 'none', 'Face accessories must not be clipped by the selected heart silhouette');
  const faceBox = await preview.locator('.avatar-face').boundingBox();
  const crownBox = await preview.locator('.avatar-accessory').boundingBox();
  assert(faceBox && crownBox && crownBox.y < faceBox.y, 'The crown must extend above the face silhouette');
  await ctx.screenshot(ctx.alphaPage!, 'avatar-customizer-preview-light');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const savedAvatar = ctx.alphaPage!.locator('.profile-link .avatar');
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('.profile-link .avatar')?.classList.contains('heart'));
  assert.match(await savedAvatar.getAttribute('class') || '', /eyes-sparkle/);
  assert.match(await savedAvatar.getAttribute('class') || '', /glasses-round/);
  assert.match(await savedAvatar.getAttribute('class') || '', /accessory-crown/);

  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'light');
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('.dot-conversation-identity .avatar')?.classList.contains('heart'));
  assert.match(await ctx.alphaPage!.locator('.dot-conversation-identity .avatar').getAttribute('class') || '', /accessory-crown/);

  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'dark');
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByRole('button', { name: 'Customize your dot' }).click();
  await editor.waitFor({ state: 'visible' });
  assert.equal(await editor.locator('.avatar-editor-preview').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(14, 24, 18)');
  await ctx.screenshot(ctx.alphaPage!, 'avatar-customizer-dark');
  await editor.getByRole('button', { name: 'Close customizer' }).click();
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'light');
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
}

export async function persistAppearance(ctx: UiScenarioContext) {
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByLabel('桌面通知').check();
  await ctx.alphaPage!.getByText('此工作区已开启任务和网页监控提醒。', { exact: true }).waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByLabel('名字').fill('Alpha Dot');
  await ctx.alphaPage!.getByRole('button', { name: '保存更改' }).click();
  await ctx.alphaPage!.locator('.profile-link strong').filter({ hasText: 'Alpha Dot' }).waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.getByLabel('桌面通知').isChecked(), true);
  await ctx.screenshot(ctx.alphaPage!, '08-alpha-profile');
}
