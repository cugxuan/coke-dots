import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function authenticatedEventStream(ctx: UiScenarioContext) {
  const eventStream = await ctx.alphaPage!.evaluate(async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/api/events', { signal: controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let frame = '';
      while (!frame.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('The event stream ended before its initial snapshot');
        frame += decoder.decode(chunk.value, { stream: true });
      }
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        buffering: response.headers.get('x-accel-buffering'),
        cacheControl: response.headers.get('cache-control'),
        snapshot: JSON.parse(frame.split('\n\n')[0].slice('data: '.length)) as { tasks: unknown[]; entries: unknown[] },
      };
    } finally {
      window.clearTimeout(timeout);
      controller.abort();
    }
  });
  assert.equal(eventStream.status, 200);
  assert.equal(eventStream.contentType, 'text/event-stream');
  assert.equal(eventStream.buffering, 'no', 'nginx/OpenResty must forward chat and voice results immediately');
  assert.match(eventStream.cacheControl || '', /no-store/);
  assert.match(eventStream.cacheControl || '', /no-transform/);
  assert(Array.isArray(eventStream.snapshot.tasks));
  assert(Array.isArray(eventStream.snapshot.entries));
}

export async function personalIsolation(ctx: UiScenarioContext) {
  await ctx.signIn(ctx.betaPage!, 'beta@example.test');
  assert.equal(await ctx.betaPage!.locator('.task-links button').count(), 0, 'Beta inherited Alpha task links');
  assert.equal(await ctx.betaPage!.getByTestId('dot-context-panel').count(), 0, 'Beta personal onboarding inherited Alpha conversation context');
  const betaState = await ctx.betaPage!.evaluate(async () => await (await fetch('/api/state')).json());
  assert.deepEqual(betaState.computerAccess, { dotComputer: true, localComputer: true, configured: false }, 'A different account must receive its own unconfigured computer-access choice');
  const betaSlackState = await ctx.betaPage!.evaluate(async () => await (await fetch('/api/slack')).json()) as { installations: unknown[] };
  assert.deepEqual(betaSlackState.installations, [], 'Beta must not inherit Alpha personal Slack installations');
  const betaDingTalkGroups = await ctx.betaPage!.evaluate(async () => await (await fetch('/api/dingtalk/groups/selected')).json()) as unknown[];
  assert.deepEqual(betaDingTalkGroups, [], 'Beta must not inherit Alpha DingTalk group selections');
  await ctx.assertNoVisibleText(ctx.betaPage!, ctx.alphaPrivateTask);
  await ctx.screenshot(ctx.betaPage!, '04-beta-isolated');
}

export async function createSharedWorkspace(ctx: UiScenarioContext) {
  await ctx.alphaPage!.locator('.workspace-switcher .new-workspace').click();
  await ctx.alphaPage!.getByLabel('新工作区名称').fill('Alpha Shared');
  await ctx.alphaPage!.locator('.workspace-switcher form').getByRole('button', { name: '创建' }).click();
  await ctx.alphaPage!.locator('.workspace-switcher select').locator('option', { hasText: 'Alpha Shared' }).waitFor({ state: 'attached' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="桌面通知"]')?.checked === false);
  assert.equal(await ctx.alphaPage!.getByLabel('桌面通知').isChecked(), false, 'A new tenant inherited personal notification preferences');
  await ctx.alphaPage!.locator('.profile-link strong').filter({ hasText: 'Dot' }).waitFor({ state: 'visible' });
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  const sharedComputerChoice = ctx.alphaPage!.getByTestId('computer-choice');
  await sharedComputerChoice.getByRole('heading', { name: 'Choose where your dot can work' }).waitFor({ state: 'visible' });
  assert.equal(await sharedComputerChoice.getByRole('switch', { name: 'Your local computer' }).isChecked(), true, 'A new workspace starts with its own first-run choice');
  await sharedComputerChoice.getByRole('button', { name: 'Continue' }).click();
  await ctx.createTask(ctx.alphaPage!, 'E2E shared workspace task — prepare the team review');
  await (await ctx.taskNavigationItem(ctx.alphaPage!, 'E2E shared workspace task')).waitFor({ state: 'visible' });
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByLabel('名字').fill('Shared Dot');
  await ctx.alphaPage!.getByRole('button', { name: '保存更改' }).click();
  await ctx.alphaPage!.locator('.profile-link strong').filter({ hasText: 'Shared Dot' }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, '09-shared-workspace');
}

export async function inviteMember(ctx: UiScenarioContext) {
  await ctx.alphaPage!.getByPlaceholder('teammate@example.com').fill('beta@example.test');
  await ctx.alphaPage!.getByRole('button', { name: '添加工作区成员' }).click();
  await ctx.alphaPage!.getByRole('region', { name: '待接受邀请' }).getByText('beta@example.test').waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByPlaceholder('teammate@example.com').fill('gamma@example.test');
  await ctx.alphaPage!.getByRole('button', { name: '添加工作区成员' }).click();
  await ctx.alphaPage!.getByRole('status').filter({ hasText: '邀请已创建' }).waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByRole('region', { name: '待接受邀请' }).getByText('gamma@example.test').waitFor({ state: 'visible' });
  await ctx.betaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.betaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.betaPage!.getByRole('region', { name: '工作区邀请' }).getByText('Alpha Shared').waitFor({ state: 'visible' });
  assert.equal(await ctx.betaPage!.locator('.workspace-switcher option').filter({ hasText: 'Alpha Shared' }).count(), 0, 'An existing Google account received access before accepting the invitation');
  await ctx.betaPage!.getByRole('button', { name: '接受并打开工作区' }).click();
  await ctx.betaPage!.locator('.workspace-switcher option').filter({ hasText: 'Alpha Shared' }).waitFor({ state: 'attached' });
  await ctx.selectTenant(ctx.betaPage!, 'Alpha Shared');
  await (await ctx.taskNavigationItem(ctx.betaPage!, 'E2E shared workspace task')).waitFor({ state: 'visible' });
  assert.equal(await ctx.betaPage!.locator('.profile-link strong').innerText(), 'Shared Dot');
  await ctx.openProfile(ctx.betaPage!);
  await ctx.betaPage!.locator('.member-row').filter({ hasText: 'alpha@example.test' }).waitFor({ state: 'visible' });
  assert.equal(await ctx.betaPage!.getByRole('button', { name: '添加工作区成员' }).isDisabled(), true, 'A regular member received workspace-admin controls');
  assert.equal(await ctx.betaPage!.getByRole('button', { name: '更改电脑访问' }).isDisabled(), true, 'A regular member cannot change shared computer access');
  const memberComputerWrite = await ctx.betaPage!.evaluate(async () => {
    const response = await fetch('/api/computer-access', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localComputer: false }) });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(memberComputerWrite.status, 403, 'The server must enforce workspace-admin access for shared computer settings');
  const memberSlackWrite = await ctx.betaPage!.evaluate(async () => {
    const response = await fetch('/api/slack/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId: 'TASPIE2E' }) });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(memberSlackWrite.status, 403, 'A regular shared-workspace member must not change the Slack contact workspace');
  await ctx.screenshot(ctx.betaPage!, '10-beta-shared-member');

  await ctx.signIn(ctx.gammaPage!, 'gamma@example.test');
  await ctx.gammaPage!.getByRole('region', { name: '工作区邀请' }).getByText('Alpha Shared').waitFor({ state: 'visible' });
  assert.equal(await ctx.gammaPage!.locator('.workspace-switcher option').filter({ hasText: 'Alpha Shared' }).count(), 0, 'A pending invitation exposed the workspace before acceptance');
  await ctx.screenshot(ctx.gammaPage!, '10b-gamma-pending-invitation');
  await ctx.gammaPage!.getByRole('button', { name: '接受并打开工作区' }).click();
  await ctx.clickNav(ctx.gammaPage!, 'Activity');
  await ctx.gammaPage!.locator('.task-card').filter({ hasText: 'E2E shared workspace task' }).waitFor({ state: 'visible' });
  assert.equal(await ctx.gammaPage!.locator('.profile-link strong').innerText(), 'Shared Dot');
  await ctx.openProfile(ctx.gammaPage!);
  await ctx.gammaPage!.locator('.member-row').filter({ hasText: 'gamma@example.test' }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.gammaPage!, '10c-gamma-accepted-workspace');
}

export async function revokeInvitations(ctx: UiScenarioContext) {
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByPlaceholder('teammate@example.com').fill('delta@example.test');
  await ctx.alphaPage!.getByRole('button', { name: '添加工作区成员' }).click();
  const deltaInvitation = ctx.alphaPage!.getByRole('region', { name: '待接受邀请' }).getByText('delta@example.test');
  await deltaInvitation.waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByRole('button', { name: '撤销 delta@example.test 的邀请' }).click();
  await deltaInvitation.waitFor({ state: 'detached' });
  assert.equal(await ctx.alphaPage!.getByRole('region', { name: '待接受邀请' }).getByText('gamma@example.test').count(), 0, 'The accepted member remained as a pending invitation');
  await ctx.alphaPage!.locator('.member-row').filter({ hasText: 'gamma@example.test' }).getByRole('button', { name: '移除' }).click();
  await ctx.alphaPage!.locator('.member-row').filter({ hasText: 'gamma@example.test' }).waitFor({ state: 'detached' });
  await ctx.gammaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.gammaPage!.getByTestId('e2e-sign-in').waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.gammaPage!, '10d-gamma-removed-session');
}

export async function switchTenant(ctx: UiScenarioContext) {
  await ctx.clickNav(ctx.betaPage!, '你的 dot');
  await ctx.selectTenant(ctx.betaPage!, 'Beta workspace');
  await (await ctx.taskNavigationItem(ctx.betaPage!, 'E2E shared workspace task')).waitFor({ state: 'detached' });
  await ctx.assertNoVisibleText(ctx.betaPage!, 'E2E shared workspace task — prepare the team review');
  await (await ctx.taskNavigationItem(ctx.betaPage!, 'E2E shared model call from Beta account')).waitFor({ state: 'visible' });
  assert.equal(await ctx.betaPage!.locator('.task-links button').count(), 1, 'Beta should retain its own shared-model test task while Alpha workspace tasks remain isolated');
  await ctx.screenshot(ctx.betaPage!, '11-beta-personal-isolation');
  await ctx.clickNav(ctx.betaPage!, 'Activity');
  const activityFeed = ctx.betaPage!.getByTestId('activity-feed');
  await activityFeed.waitFor({ state: 'visible' });
  await activityFeed.getByTestId('activity-entry').filter({ hasText: 'E2E shared model call from Beta account' }).first().waitFor({ state: 'visible' });
  assert.equal(await activityFeed.getByTestId('activity-entry').filter({ hasText: ctx.alphaPrivateTask }).count(), 0, 'Beta received an Alpha activity entry');
  await ctx.screenshot(ctx.betaPage!, '11b-beta-private-activity');
}

export async function restoreAfterRestart(ctx: UiScenarioContext) {
  await ctx.restartService();
  await ctx.alphaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.betaPage!.reload({ waitUntil: 'domcontentloaded' });
  await ctx.alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.betaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
  await ctx.betaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
  await ctx.openProfile(ctx.alphaPage!);
  assert.equal(await ctx.alphaPage!.getByLabel('桌面通知').isChecked(), false, 'Alpha Shared lost its independent notification preference after restart');
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha workspace');
  assert.equal(await ctx.alphaPage!.getByLabel('桌面通知').isChecked(), true, 'Alpha personal notification preference did not survive service restart');
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  await (await ctx.taskNavigationItem(ctx.alphaPage!, 'E2E shared workspace task')).waitFor({ state: 'visible' });
  await ctx.selectTenant(ctx.betaPage!, 'Alpha Shared');
  await (await ctx.taskNavigationItem(ctx.betaPage!, 'E2E shared workspace task')).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, '12-alpha-after-service-restart');
  await ctx.screenshot(ctx.betaPage!, '13-beta-after-service-restart');
  await ctx.selectTenant(ctx.betaPage!, 'Beta workspace');
  const betaModelState = await ctx.betaPage!.evaluate(async () => await (await fetch('/api/state')).json());
  assert.equal(betaModelState.modelSettings.baseUrl, ctx.testModelBaseUrl, 'Shared model endpoint did not survive restart');
  assert.equal(betaModelState.modelSettings.model, ctx.testModelName, 'Shared model name did not survive restart');
  assert.equal(betaModelState.modelSettings.hasKey, true, 'Shared model K3D Secret credential did not survive restart');
  assert(betaModelState.availableEngines.includes('model'), 'Beta lost access to the instance model after restart');
  await (await ctx.taskNavigationItem(ctx.betaPage!, 'E2E shared workspace task')).waitFor({ state: 'detached' });
}
